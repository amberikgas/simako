# Si-MAKO v3.1 — Sistem Manajemen Konveksi (Edisi GAS-PRO-API)

Aplikasi manajemen operasional, HPP, stok bahan, invoice PDF, dan keuangan konveksi dengan arsitektur **Frontend Terpisah (Vercel)** dan **Google Apps Script sebagai REST API (`doGet` / `doPost`)**.

**Fitur v3.1:**
- **Keamanan login:** email + sandi, token sesi bertanda tangan HMAC, dan kunci otomatis setelah 5× salah. Sandi sementara diberikan per pengguna, dengan peran Owner/Admin yang dicek di server.
- **Kecepatan:** data tampil instan dari perangkat. Server hanya mengirim data yang berubah, memakai cache berversi per sheet, dan lock yang lebih singkat.
- **Tahan sinyal HP:** timeout serta percobaan ulang otomatis, tanpa risiko data tersimpan ganda.

## Struktur folder frontend

```
.
├── index.html             <- Halaman utama aplikasi (SPA)
├── vercel.json            <- Konfigurasi deployment Vercel
├── README.md
├── PANDUAN-INSTALASI.md   <- Instalasi backend GAS & frontend Vercel untuk klien baru
├── css/
│   └── style.css
└── js/
    ├── config.js          <- URL backend (/exec) — satu-satunya file yang diedit per klien
    └── app.js             <- Controller Vanilla JS + fetch ke Google Apps Script
```

> **Penting:** berkas backend `Kode.gs` sengaja dipisahkan dari paket ini agar tidak ikut ter-upload ke repositori publik. Salin `Kode.gs` langsung ke editor Google Apps Script milik klien.
