import express from 'express';
import cors from 'cors';
import fs from 'fs';
import readline from 'readline';
import { exec } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM __dirname workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dynamic import for axios (ESM compatible)
let axios;
(async () => { axios = (await import('axios')).default; })();

const app = express();
app.use(cors());
app.use(express.json());

const DB_FILE = 'database.json';

// Initialize DB if not exists
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], locations: {} }, null, 2));
}

// Load DB
function loadDB() {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')); }
    catch(e) { return { users: [], locations: {}, notes: [] }; }
}

// Save DB
function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------
// JNE SCA AUTHENTICATION ENGINE
// ---------------------------------------------------------
const JNE_EMAIL = '3310134206930001';
const JNE_PASSWORD = 'y3#DeZ7o';
const TOTP_SECRET = 'EVKSG535EY5DSTS2';
const LOGIN_URL = 'https://sca.jne.id/lm-api/user/auth/login';
const TOKEN_FILE = path.join(__dirname, '.jne_token.json');

function generateTOTP() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let buf = [];
    let bits = 0;
    let value = 0;
    for (let i = 0; i < TOTP_SECRET.length; i++) {
        value = (value << 5) | alphabet.indexOf(TOTP_SECRET[i].toUpperCase());
        bits += 5;
        if (bits >= 8) { buf.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    const key = Buffer.from(buf);
    const epoch = Math.floor(Date.now() / 1000);
    const time = Buffer.alloc(8);
    time.writeUInt32BE(Math.floor(epoch / 30), 4);
    const hmac = crypto.createHmac('sha1', key).update(time).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
    return (code % 1000000).toString().padStart(6, '0');
}

async function performJNELogin() {
    console.log('🔄 [JNE-AUTH] Melakukan proses Auto-Login ke SCA JNE...');
    const otp = generateTOTP();
    try {
        const response = await axios.post(LOGIN_URL, {
            email: JNE_EMAIL, password: JNE_PASSWORD, totp: otp
        }, { timeout: 10000 });
        if (response.data && response.data.success) {
            const token = response.data.data.access_token;
            const payloadData = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
            const tokenData = { token: `Bearer ${token}`, expiresAt: payloadData.exp * 1000 };
            fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
            console.log('✅ [JNE-AUTH] Login Berhasil!');
            return tokenData.token;
        }
        throw new Error("Gagal login: " + JSON.stringify(response.data));
    } catch (e) {
        console.error('❌ [JNE-AUTH] Auto-Login Gagal:', e.response ? e.response.data : e.message);
        throw e;
    }
}

async function getValidToken() {
    if (fs.existsSync(TOKEN_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
            if (Date.now() < data.expiresAt - (5 * 60 * 1000)) return data.token;
        } catch (e) {}
    }
    return await performJNELogin();
}

// ---------------------------------------------------------
// JNE DATA TOOLS (MCP-Like Functions)
// ---------------------------------------------------------
async function fetchJNEDashboard() {
    try {
        const token = await getValidToken();
        const now = new Date();
        const pad = n => n < 10 ? '0' + n : n;
        const dateOnly = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
        const url = `https://sca.jne.id/lm-api/dashboard/report?from=${dateOnly}&to=${dateOnly}&result_type=list`;
        const response = await axios.get(url, { headers: { "Authorization": token } });
        return { data: response.data.data || [], date: dateOnly };
    } catch (e) {
        console.error('[JNE-TOOL] Gagal ambil data dashboard:', e.message);
        return { data: [], date: '' };
    }
}

function buildCourierSummary(data) {
    let couriersMap = {};
    for (let p of data) {
        if (!p.MRSHEET_COURIER_ID) continue;
        const cid = p.MRSHEET_COURIER_ID;
        if (!couriersMap[cid]) couriersMap[cid] = {
            total: 0, status: 'Closing',
            name: p.COURIER_NAME || p.MRSHEET_COURIER_NAME || p.DRSHEET_COURIER_NAME || cid,
            delivered: 0, failed: 0, unprocessed: 0, packages: []
        };
        couriersMap[cid].total++;
        // Simpan data paket individu untuk pencarian
        couriersMap[cid].packages.push({
            awb: p.AWB_NUMBER || p.CONNOTE || '',
            recipient: p.CONSIGNEE_NAME || p.consignee_name || '',
            address: p.CONSIGNEE_ADDRESS || '',
            status: p.POD_STATUS || 'On Process',
            drStatus: p.DRSHEET_STATUS || ''
        });
        if (!p.POD_STATUS || p.POD_STATUS.trim() === '') {
            couriersMap[cid].status = 'On Process';
            couriersMap[cid].unprocessed++;
        } else if (p.DRSHEET_STATUS && p.DRSHEET_STATUS.startsWith('D')) {
            couriersMap[cid].delivered++;
        } else {
            couriersMap[cid].failed++;
        }
    }
    return couriersMap;
}

function searchPackageByName(data, name) {
    const lower = name.toLowerCase();
    return data.filter(p => {
        const consignee = (p.CONSIGNEE_NAME || p.consignee_name || '').toLowerCase();
        return consignee.includes(lower);
    }).map(p => ({
        awb: p.AWB_NUMBER || p.CONNOTE || 'N/A',
        recipient: p.CONSIGNEE_NAME || p.consignee_name || 'N/A',
        courier: p.COURIER_NAME || p.MRSHEET_COURIER_NAME || p.MRSHEET_COURIER_ID || 'N/A',
        courierId: p.MRSHEET_COURIER_ID || 'N/A',
        status: p.POD_STATUS || 'Belum Diupdate',
        address: p.CONSIGNEE_ADDRESS || 'N/A'
    }));
}

// ---------------------------------------------------------
// API ENDPOINTS (For Android App)
// ---------------------------------------------------------

// 1. Register / Login
app.post('/api/login', (req, res) => {
    const { name, age, dob, whatsapp, password, lat, lng } = req.body;
    let db = loadDB();
    let user = db.users.find(u => u.whatsapp === whatsapp);
    if (!user) {
        user = { name, age, dob, whatsapp, password, isBanned: false };
        db.users.push(user);
    } else {
        if (user.password !== password) return res.status(401).json({ error: 'Password salah' });
        if (user.isBanned) return res.status(403).json({ error: 'Akun Anda telah di-banned.' });
    }
    if (lat && lng) {
        db.locations[whatsapp] = { name: user.name, lat, lng, timestamp: new Date().toISOString() };
    }
    saveDB(db);
    res.json({ success: true, message: 'Login berhasil', user });
});

// 2. Update Location
app.post('/api/location', (req, res) => {
    const { whatsapp, lat, lng } = req.body;
    let db = loadDB();
    let user = db.users.find(u => u.whatsapp === whatsapp);
    if (user && !user.isBanned) {
        db.locations[whatsapp] = { name: user.name, lat, lng, timestamp: new Date().toISOString() };
        saveDB(db);
        return res.json({ success: true });
    }
    res.status(403).json({ error: 'Unauthorized or banned' });
});

// 3. Alert GPS Dimatikan
app.post('/api/gps-status', (req, res) => {
    const { whatsapp, status } = req.body;
    if (status === false) {
        let db = loadDB();
        const user = db.users.find(u => u.whatsapp === whatsapp);
        const name = user ? user.name : "Karyawan Tak Dikenal";
        console.log(`\n🚨 ALARM PELANGGARAN! 🚨`);
        console.log(`⚠️ Pekerja: ${name} (WA: ${whatsapp})`);
        console.log(`⚠️ Status: MEMATIKAN GPS SECARA SENGAJA!`);
        console.log(`🚨 ALARM PELANGGARAN! 🚨\n`);
    }
    res.json({ success: true });
});

// 4. Get Data Karyawan
app.get('/api/users', (req, res) => {
    let db = loadDB();
    const safeUsers = db.users.map(u => ({ name: u.name, whatsapp: u.whatsapp, age: u.age, isBanned: u.isBanned }));
    res.json({ success: true, users: safeUsers });
});

// 5. GET Catatan Mading
app.get('/api/notes', (req, res) => {
    let db = loadDB();
    if (!db.notes) { db.notes = []; saveDB(db); }
    res.json({ success: true, notes: db.notes });
});

// 6. POST Tambah/Update Catatan Mading
app.post('/api/notes', (req, res) => {
    const { id, text, color, offsetX, offsetY } = req.body;
    let db = loadDB();
    if (!db.notes) db.notes = [];
    const idx = db.notes.findIndex(n => n.id === id);
    if (idx >= 0) { db.notes[idx].offsetX = offsetX; db.notes[idx].offsetY = offsetY; }
    else { db.notes.push({ id, text, color, offsetX, offsetY }); }
    saveDB(db);
    res.json({ success: true });
});

// 7. DELETE Catatan Mading
app.delete('/api/notes/:id', (req, res) => {
    let db = loadDB();
    if (db.notes) { db.notes = db.notes.filter(n => n.id !== parseInt(req.params.id)); saveDB(db); }
    res.json({ success: true });
});

// Start Server
const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n==============================================`);
    console.log(`🚀 MABES SUPER SERVER MENYALA DI PORT ${PORT}`);
    console.log(`   🤖 AI Engine: Gemini 3.5 Flash`);
    console.log(`   📦 JNE SCA: Tool MCP Aktif`);
    console.log(`   📱 Android API: Online`);
    console.log(`==============================================\n`);
    startCLI();
});

// ---------------------------------------------------------
// CLI ADMIN CONSOLE (Termux Interface)
// ---------------------------------------------------------
function startCLI() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'MABES-ADMIN> '
    });

    rl.prompt();

    rl.on('line', (line) => {
        const args = line.trim().split(' ');
        const cmd = args[0].toLowerCase();
        let db = loadDB();

        switch (cmd) {
            case '/wa':
                console.log(`\n📱 Memulai proses koneksi WhatsApp...`);
                rl.question('Masukkan Nomor WA Bot (awali dengan 60/62, misal 62812...): ', async (waNumber) => {
                    await startWhatsAppBot(waNumber.replace(/[^0-9]/g, ''), rl);
                });
                break;

            case '/help':
                console.log(`\n--- DAFTAR PERINTAH ---`);
                console.log(`/wa             : Sambungkan Server ini ke WhatsApp Bot`);
                console.log(`/list           : Lihat semua pekerja yang terdaftar`);
                console.log(`/lokasi         : Lihat koordinat GPS & link Maps semua pekerja`);
                console.log(`/ban {nama/wa}  : Blokir pekerja dari aplikasi`);
                console.log(`/unban {wa}     : Buka blokir pekerja`);
                console.log(`-----------------------\n`);
                break;

            case '/list':
                console.log(`\n--- DAFTAR PEKERJA ---`);
                if (db.users.length === 0) console.log("Belum ada yang mendaftar.");
                db.users.forEach(u => {
                    const status = u.isBanned ? '[BANNED]' : '[AKTIF]';
                    console.log(`- ${u.name} | WA: ${u.whatsapp} | Umur: ${u.age} ${status}`);
                });
                console.log(`----------------------\n`);
                break;

            case '/lokasi':
                console.log(`\n--- LOKASI REALTIME PEKERJA ---`);
                const locKeys = Object.keys(db.locations);
                if (locKeys.length === 0) console.log("Belum ada data lokasi.");
                locKeys.forEach(wa => {
                    const loc = db.locations[wa];
                    const mapsLink = `https://maps.google.com/?q=${loc.lat},${loc.lng}`;
                    console.log(`📍 ${loc.name} (WA: ${wa})`);
                    console.log(`   Waktu: ${loc.timestamp}`);
                    console.log(`   Maps : ${mapsLink}`);
                });
                console.log(`-------------------------------\n`);
                break;

            case '/ban':
                if (args.length < 2) {
                    console.log(`Gunakan format: /ban <nomor_wa> atau /ban <nama>`);
                } else {
                    const target = args.slice(1).join(' ');
                    const user = db.users.find(u => u.whatsapp === target || u.name.toLowerCase() === target.toLowerCase());
                    if (user) {
                        user.isBanned = true;
                        saveDB(db);
                        console.log(`\n🚫 BERHASIL! Pekerja [${user.name}] telah di-ban.\n`);
                    } else {
                        console.log(`\n❌ Pekerja '${target}' tidak ditemukan.\n`);
                    }
                }
                break;

            case '/unban':
                if (args.length < 2) {
                    console.log(`Gunakan format: /unban <nomor_wa>`);
                } else {
                    const user = db.users.find(u => u.whatsapp === args[1]);
                    if (user) {
                        user.isBanned = false;
                        saveDB(db);
                        console.log(`\n✅ Pekerja [${user.name}] telah dibuka blokirnya.\n`);
                    }
                }
                break;

            case '': break;

            default:
                console.log(`Perintah '${cmd}' tidak dikenal. Ketik /help untuk bantuan.\n`);
                break;
        }
        rl.prompt();
    }).on('close', () => {
        console.log('Server dimatikan.');
        process.exit(0);
    });
}

// ---------------------------------------------------------
// WHATSAPP BOT ENGINE + JNE AUDIT + AI AGENT
// ---------------------------------------------------------
async function startWhatsAppBot(phoneNumber, rl) {
    try {
        const baileys = await import('@whiskeysockets/baileys');
        const pinoModule = await import('pino');
        const pino = pinoModule.default || pinoModule;

        const makeWASocket = baileys.default || baileys.makeWASocket;
        const { useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, DisconnectReason } = baileys;

        const { version } = await fetchLatestBaileysVersion();

        // Minta nomor telepon SEBELUM membuka koneksi agar event QR tidak terlewat
        const { state, saveCreds } = await useMultiFileAuthState('wa_session');

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            logger: pino({ level: 'silent' }),
            browser: ["Ubuntu", "Chrome", "120.0.0"],
            printQRInTerminal: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && !sock.authState.creds.registered) {
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    console.log(`\n=========================================`);
                    console.log(`🔐 KODE PAIRING WHATSAPP: ${code}`);
                    console.log(`=========================================`);
                    console.log(`1. Buka WhatsApp > Perangkat Tertaut`);
                    console.log(`2. Pilih "Tautkan dengan Nomor Telepon"`);
                    console.log(`3. Masukkan kode di atas`);
                    console.log(`=========================================\n`);
                    rl.prompt();
                } catch (err) {
                    console.log('\n❌ Gagal meminta Pairing Code.', err.message);
                    rl.prompt();
                }
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason?.loggedOut;
                console.log('\n❌ Koneksi WA terputus.');
                if (shouldReconnect) {
                    console.log('⏳ Menyambung ulang dalam 3 detik...');
                    setTimeout(() => startWhatsAppBot(phoneNumber, rl), 3000);
                }
                rl.prompt();
            } else if (connection === 'open') {
                console.log('\n✅ Bot WhatsApp Berhasil Terhubung ke Mabes!');
                rl.prompt();
            }
        });

        // ==========================================
        // UNIFIED MESSAGE HANDLER
        // ==========================================
        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const messageType = Object.keys(msg.message)[0];
            const text = msg.message.conversation || msg.message[messageType]?.text || '';
            if (!text) return;

            const chatId = msg.key.remoteJid;
            const isGroup = chatId.endsWith('@g.us');
            const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            const contextInfo = msg.message[messageType]?.contextInfo;
            const isMentioned = contextInfo?.mentionedJid?.includes(botNumber);
            const isReplyToBot = contextInfo?.participant === botNumber;

            // ==========================================
            // HANDLER 1: Perintah /cek (JNE Audit)
            // ==========================================
            if (text.startsWith('/cek')) {
                const args = text.trim().split(/\s+/).slice(1);
                const param = args[0] ? args[0].toUpperCase() : null;

                try {
                    let statusMsg = await sock.sendMessage(chatId, { text: "⏳ *[1/2]* Mengambil data JNE hari ini..." }, { quoted: msg });
                    const { data, date } = await fetchJNEDashboard();

                    if (data.length === 0) {
                        await sock.sendMessage(chatId, { text: "❌ Tidak ada data kurir hari ini.", edit: statusMsg.key });
                        return;
                    }

                    // Sinkronisasi data ke SCA
                    const token = await getValidToken();
                    const pad = n => n < 10 ? '0' + n : n;
                    const now = new Date();
                    const fullDateTime = `${date} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

                    let nameToIdMap = {};
                    for (let p of data) {
                        if (p.MRSHEET_COURIER_ID) {
                            const cid = p.MRSHEET_COURIER_ID.toUpperCase();
                            nameToIdMap[cid] = cid;
                            const cName = p.COURIER_NAME || p.MRSHEET_COURIER_NAME;
                            if (cName) nameToIdMap[cName.toUpperCase()] = cid;
                        }
                    }

                    let actualCourierId = param ? (nameToIdMap[param] || param) : null;

                    // Sync dengan server JNE
                    try {
                        if (actualCourierId && actualCourierId !== "SEMUA") {
                            await axios.post('https://sca.jne.id/lm-api/sync/delivery?refresh=true',
                                { from: fullDateTime, to: fullDateTime, couriers: [actualCourierId] },
                                { headers: { "Authorization": token }, timeout: 15000 });
                        } else {
                            const allIds = Object.values(nameToIdMap).filter((v, i, a) => a.indexOf(v) === i);
                            if (allIds.length > 0) {
                                await axios.post('https://sca.jne.id/lm-api/sync/delivery?refresh=true',
                                    { from: fullDateTime, to: fullDateTime, couriers: allIds },
                                    { headers: { "Authorization": token }, timeout: 30000 });
                            }
                        }
                    } catch (e) { console.log("Sync Error:", e.message); }

                    // Ambil data ulang setelah sync
                    await sock.sendMessage(chatId, { text: "🔍 *[2/2]* Menganalisis status kurir...", edit: statusMsg.key });
                    const freshResp = await axios.get(`https://sca.jne.id/lm-api/dashboard/report?from=${date}&to=${date}&result_type=list`, { headers: { "Authorization": token } });
                    const freshData = freshResp.data.data || [];
                    const couriersMap = buildCourierSummary(freshData);

                    // /cek tanpa parameter = Dashboard
                    if (!param) {
                        let replyText = `🤖 *Dashboard Kurir Hari Ini (${date})*\n\n`;
                        let closingText = "", onProcessText = "";
                        for (let cid in couriersMap) {
                            let c = couriersMap[cid];
                            let pct = c.total > 0 ? Math.round((c.delivered / c.total) * 100) : 0;
                            let statStr = `👤 *${cid}* (${c.name})\n📦 Total: ${c.total} | ✅ ${c.delivered} | ❌ ${c.failed} (${pct}%)\n`;
                            if (c.status === 'Closing') closingText += statStr + `\n`;
                            else onProcessText += statStr + `⏳ Sisa: ${c.unprocessed} Pkt\n\n`;
                        }
                        replyText += `🟢 *SUDAH CLOSING:*\n${closingText || 'Belum ada\n'}\n`;
                        replyText += `🟡 *BELUM CLOSING:*\n${onProcessText || 'Tidak ada\n'}\n`;
                        replyText += `👉 Ketik */cek nama_kurir* untuk detail.`;
                        await sock.sendMessage(chatId, { text: replyText });
                        return;
                    }

                    // /cek <ID>
                    if (!couriersMap[actualCourierId]) {
                        await sock.sendMessage(chatId, { text: `❌ Kurir *${actualCourierId}* tidak ditemukan hari ini.` });
                        return;
                    }
                    let c = couriersMap[actualCourierId];
                    let pct = c.total > 0 ? Math.round((c.delivered / c.total) * 100) : 0;
                    let detailMsg = `📊 *Detail Kurir: ${actualCourierId}* (${c.name})\n📅 Tanggal: ${date}\n\n`;
                    detailMsg += `📦 Total Paket: ${c.total}\n`;
                    detailMsg += `✅ Sukses: ${c.delivered} (${pct}%)\n`;
                    detailMsg += `❌ Gagal: ${c.failed}\n`;
                    detailMsg += `⏳ Belum Update: ${c.unprocessed}\n`;
                    detailMsg += `📋 Status: *${c.status}*`;
                    await sock.sendMessage(chatId, { text: detailMsg });

                } catch (error) {
                    console.error("JNE Error:", error?.message);
                    try {
                        await sock.sendMessage(chatId, { text: "❌ Terjadi kesalahan saat memproses JNE." });
                    } catch (e) {}
                }
                return;
            }

            // ==========================================
            // HANDLER 2: Perintah / lain = Abaikan
            // ==========================================
            if (text.startsWith('/')) return;

            // ==========================================
            // HANDLER 3: AI AGENT (Hanya jika di-mention atau di-reply)
            // ==========================================
            if (!isMentioned && !isReplyToBot) return;

            const cleanText = text.replace(/@\d+/g, '').trim();
            if (!cleanText) return;

            // Kirim penanda sedang memproses
            let processMsg = await sock.sendMessage(chatId, { text: '⏳ *[Mabes AI]* Sedang mengumpulkan data & memikirkan jawaban...' }, { quoted: msg });

            // TOOL MCP: Ambil data JNE untuk konteks AI
            let jneContext = "";
            try {
                const { data, date } = await fetchJNEDashboard();
                if (data.length > 0) {
                    // Cari apakah user bertanya soal nama orang/paket
                    const results = searchPackageByName(data, cleanText);
                    if (results.length > 0) {
                        jneContext = `\n\n[DATA PAKET JNE HARI INI YANG COCOK]:\n`;
                        results.slice(0, 10).forEach(r => {
                            jneContext += `- Resi: ${r.awb}, Penerima: ${r.recipient}, Kurir: ${r.courier} (${r.courierId}), Status: ${r.status}, Alamat: ${r.address}\n`;
                        });
                    }

                    // Selalu sertakan ringkasan dashboard
                    const couriersMap = buildCourierSummary(data);
                    jneContext += `\n[RINGKASAN DASHBOARD KURIR ${date}]:\n`;
                    for (let cid in couriersMap) {
                        let c = couriersMap[cid];
                        jneContext += `- ${cid} (${c.name}): Total ${c.total} pkt, Sukses ${c.delivered}, Gagal ${c.failed}, Sisa ${c.unprocessed}, Status: ${c.status}\n`;
                    }
                }
            } catch (e) {
                console.log('[AI-TOOL] Gagal ambil data JNE untuk konteks:', e.message);
            }

            // Juga sertakan data lokasi pekerja dari database Mabes
            let mabesContext = "";
            try {
                const db = loadDB();
                if (db.users.length > 0) {
                    mabesContext += `\n[DATA PEKERJA MABES]:`;
                    db.users.forEach(u => {
                        const loc = db.locations[u.whatsapp];
                        const locStr = loc ? `Lat: ${loc.lat}, Lng: ${loc.lng} (${loc.timestamp})` : "Tidak ada data lokasi";
                        mabesContext += `\n- ${u.name} (WA: ${u.whatsapp}), Banned: ${u.isBanned}, Lokasi: ${locStr}`;
                    });
                }
            } catch (e) {}

            // Kirim ke Gemini CLI menggunakan arsitektur spawn yang lebih stabil (tanpa injeksi shell)
            const { spawn } = await import('child_process');
            
            const aiPrompt = `Kamu adalah Asisten AI Super untuk Server Mabes & JNE. Kamu punya akses data real-time dari sistem JNE SCA dan database pekerja Mabes. Gunakan data berikut untuk menjawab pertanyaan. Jawab dalam Bahasa Indonesia yang ringkas dan padat.\n\n${jneContext}\n${mabesContext}\n\nPertanyaan: ${cleanText}`;

            // Jika di Windows, gemini CLI biasanya dijalankan melalui cmd.exe
            const isWin = process.platform === "win32";
            const cmdBin = isWin ? "gemini.cmd" : "gemini";
            
            const child = spawn(cmdBin, ["--model", "gemini-3.1-pro", "--prompt", aiPrompt], {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let outData = "";
            let errData = "";

            child.stdout.on('data', (chunk) => outData += chunk.toString());
            child.stderr.on('data', (chunk) => errData += chunk.toString());

            child.on('close', async (code) => {
                if (code !== 0 && !outData.trim()) {
                    const errMsg = (errData || `Exited with code ${code}`).substring(0, 300);
                    console.error(`[AI Error] ${errMsg}`);
                    await sock.sendMessage(chatId, {
                        text: `❌ *Mabes AI Error:*\n\`\`\`${errMsg}\`\`\``,
                        edit: processMsg.key
                    });
                } else if (outData.trim()) {
                    await sock.sendMessage(chatId, {
                        text: '🤖 *Mabes AI:*\n\n' + outData.trim(),
                        edit: processMsg.key
                    });
                }
            });
        });

    } catch (e) {
        console.error("Gagal memulai modul WhatsApp:", e);
        rl.prompt();
    }
}
