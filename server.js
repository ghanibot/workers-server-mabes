import express from 'express';
import cors from 'cors';
import fs from 'fs';
import readline from 'readline';

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
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}

// Save DB
function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
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
        // Register
        user = { name, age, dob, whatsapp, password, isBanned: false };
        db.users.push(user);
    } else {
        // Check password and ban status
        if (user.password !== password) return res.status(401).json({ error: 'Password salah' });
        if (user.isBanned) return res.status(403).json({ error: 'Akun Anda telah di-banned.' });
    }

    // Update realtime location
    if (lat && lng) {
        db.locations[whatsapp] = {
            name: user.name,
            lat,
            lng,
            timestamp: new Date().toISOString()
        };
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
        db.locations[whatsapp] = {
            name: user.name,
            lat,
            lng,
            timestamp: new Date().toISOString()
        };
        saveDB(db);
        return res.json({ success: true });
    }
    res.status(403).json({ error: 'Unauthorized or banned' });
});

// 3. Alert GPS Dimatikan
app.post('/api/gps-status', (req, res) => {
    const { whatsapp, status } = req.body;
    let db = loadDB();
    let user = db.users.find(u => u.whatsapp === whatsapp);
    
    if (user && status === false) {
        console.log(`\n\n🚨 [ALARM SISTEM] Karyawan ${user.name} (WA: ${whatsapp}) BARU SAJA MEMATIKAN GPS/LOKASI! 🚨\n`);
        return res.json({ success: true });
    }
    res.status(400).json({ error: 'Invalid data' });
});

// 4. Get Data Karyawan (Untuk Menu Daftar di Android)
app.get('/api/users', (req, res) => {
    let db = loadDB();
    // Kirim data tapi sembunyikan password demi keamanan
    const safeUsers = db.users.map(u => ({
        name: u.name,
        whatsapp: u.whatsapp,
        age: u.age,
        isBanned: u.isBanned
    }));
    res.json({ success: true, users: safeUsers });
});

// 5. GET Semua Catatan Mading Global
app.get('/api/notes', (req, res) => {
    let db = loadDB();
    if (!db.notes) {
        db.notes = [];
        saveDB(db);
    }
    res.json({ success: true, notes: db.notes });
});

// 6. POST Tambah/Update Catatan Mading
app.post('/api/notes', (req, res) => {
    const { id, text, color, offsetX, offsetY } = req.body;
    let db = loadDB();
    if (!db.notes) db.notes = [];
    
    const existingIndex = db.notes.findIndex(n => n.id === id);
    if (existingIndex >= 0) {
        // Update koordinat posisi
        db.notes[existingIndex].offsetX = offsetX;
        db.notes[existingIndex].offsetY = offsetY;
    } else {
        // Tambah baru
        db.notes.push({ id, text, color, offsetX, offsetY });
    }
    saveDB(db);
    res.json({ success: true });
});

// 7. DELETE Catatan Mading
app.delete('/api/notes/:id', (req, res) => {
    const id = parseInt(req.params.id);
    let db = loadDB();
    if (db.notes) {
        db.notes = db.notes.filter(n => n.id !== id);
        saveDB(db);
    }
    res.json({ success: true });
});

// Start Server
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`\n==============================================`);
    console.log(`🚀 MABES SERVER (API) MENYALA DI PORT ${PORT}`);
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
                rl.question('Masukkan Nomor WA Bot (awali dengan 62, misal 62812...): ', async (waNumber) => {
                    await startWhatsAppBot(waNumber.replace(/[^0-9]/g, ''), rl);
                });
                break;
                
            case '/help':
                console.log(`\n--- DAFTAR PERINTAH ---`);
                console.log(`/wa             : Sambungkan Server ini ke WhatsApp Bot (Pairing Code)`);
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
                        console.log(`\n🚫 BERHASIL! Pekerja [${user.name}] telah di-ban dan tidak bisa login lagi.\n`);
                    } else {
                        console.log(`\n❌ Pekerja dengan nama/WA '${target}' tidak ditemukan.\n`);
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
                
            case '':
                break;
                
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
// WHATSAPP BOT ENGINE
// ---------------------------------------------------------
async function startWhatsAppBot(phoneNumber, rl) {
    try {
        const baileys = await import('@whiskeysockets/baileys');
        const pinoModule = await import('pino');
        const pino = pinoModule.default || pinoModule;
        
        const makeWASocket = baileys.default || baileys.makeWASocket;
        const { useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = baileys;

        const { version } = await fetchLatestBaileysVersion();
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

        if (!sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    console.log(`\n=========================================`);
                    console.log(`🔐 KODE PAIRING WHATSAPP: ${code}`);
                    console.log(`=========================================`);
                    console.log(`Langkah-langkah:`);
                    console.log(`1. Buka aplikasi WhatsApp di HP`);
                    console.log(`2. Pilih menu "Perangkat Tertaut" (Linked Devices)`);
                    console.log(`3. Pilih "Tautkan dengan Nomor Telepon"`);
                    console.log(`4. Masukkan kode di atas`);
                    console.log(`=========================================\n`);
                    rl.prompt();
                } catch (err) {
                    console.log('Gagal meminta Pairing Code:', err);
                    rl.prompt();
                }
            }, 3000);
        }

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                console.log('\n❌ Koneksi WA terputus.');
                rl.prompt();
            } else if (connection === 'open') {
                console.log('\n✅ Bot WhatsApp Berhasil Terhubung ke Mabes!');
                rl.prompt();
            }
        });

    } catch (e) {
        console.error("Gagal memulai modul WhatsApp:", e);
        rl.prompt();
    }
}
