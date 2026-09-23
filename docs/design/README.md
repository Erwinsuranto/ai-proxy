# Admin Dashboard — Design Reference

## File

| | |
|---|---|
| **Reference image** | `admin-dashboard-reference.png` (this folder) |
| **Role** | Primary visual reference for the nvidia-api Admin Dashboard |
| **Applies to** | `src/admin/index.html`, `src/admin/styles.css`, `src/admin/dashboard.ts` |

`admin-dashboard-reference.png` adalah **referensi visual utama** untuk Admin Dashboard.
Semua pengembangan UI berikutnya **wajib mengikuti desain tersebut**.

## Theme: LIGHT (bukan dark theme)

- Background putih / sangat terang
- Primary blue untuk aksi & elemen aktif
- Teks dark navy
- Card putih dengan border tipis dan shadow sangat ringan
- Status success = hijau · status danger = merah
- Gaya keseluruhan: modern, clean, profesional
- **Jangan** menjadikan background gelap sebagai tema utama

## Acuan desain (checklist untuk setiap perubahan UI)

Saat mengubah atau menambah UI, gunakan gambar referensi sebagai acuan untuk:

- [ ] Warna (palette light theme di atas)
- [ ] Spacing
- [ ] Typography
- [ ] Card
- [ ] Button
- [ ] Sidebar
- [ ] Header
- [ ] Provider cards
- [ ] Status badge
- [ ] Layout
- [ ] Responsive behavior
- [ ] Border radius
- [ ] Icon style
- [ ] Hierarchy informasi

## Navigasi — pembagian tanggung jawab

Struktur navigasi pada desain harus dipahami sebagai DUA peran berbeda yang
TIDAK boleh saling diduplikasi:

| Area | Peran |
|---|---|
| **Sidebar** | Navigasi utama aplikasi (pindah antar section/halaman) |
| **Header** | Kontrol halaman/global: search, refresh, system status, admin profile |

Jangan membuat menu sidebar dan menu header memiliki fungsi yang sama.

## Catatan untuk task berikutnya

- Tahap penyimpanan referensi ini TIDAK mengubah UI existing.
- Perubahan implementasi UI mengikuti desain ini dilakukan pada task terpisah,
  selalu dengan merujuk langsung ke `admin-dashboard-reference.png`.
