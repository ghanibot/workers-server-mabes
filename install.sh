#!/bin/bash
echo "Memulai instalasi dependencies Server Mabes..."

# Update sistem Termux
pkg update && pkg upgrade -y

# Install Node.js dan Git
pkg install nodejs git -y

# Install GLIBC dan Antigravity CLI sebagai engine QA
echo "Menginstal Antigravity CLI (QA Engine)..."
pkg install glibc-repo -y
pkg install antigravity-cli -y

# Install Node.js dependencies (baileys, dll)
echo "Menginstal library Node.js..."
npm install

echo "Selesai! Anda sekarang bisa menjalankan server dengan perintah:"
echo "node server.js"
