# Si-MAKO — Sistem Manajemen Konveksi (Edisi GAS-PRO-API)

Aplikasi manajemen operasional, HPP, stok bahan, invoice PDF, dan keuangan konveksi dengan arsitektur **Frontend Terpisah (Vercel)** dan **Google Apps Script Pure REST API (`doGet` / `doPost`)**.

## Struktur Folder Frontend (Siap Deploy ke Vercel / GitHub Pages)

```
.
├── index.html             <- Halaman utama aplikasi (SPA)
├── vercel.json            <- Konfigurasi deployment Vercel
├── README.md              <- Ringkasan repositori
├── PANDUAN-INSTALASI.md   <- Panduan lengkap instalasi Backend GAS & Frontend Vercel
├── css/
│   └── style.css          <- Stylesheet Garment Operations Engine (Light & Dark Mode)
└── js/
    └── app.js             <- Controller Vanilla JS + Fetch REST API ke Google Apps Script
```

> **Penting:** Berkas backend `Kode.gs` sengaja dipisahkan dari paket ini agar tidak ikut ter-upload ke repositori publik. Salin `Kode.gs` langsung ke editor Google Apps Script Anda.
