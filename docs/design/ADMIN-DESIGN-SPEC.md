# Admin Dashboard — Design Specification (Source of Truth)

> **Tujuan dokumen:** acuan tekstual untuk AI coding / developer agar UI Admin
> Dashboard `nvidia-api` dapat diimplementasikan **tanpa perlu melihat gambar**
> referensi (`admin-dashboard-reference.png`).
>
> **Sumber:** audit kode frontend existing di:
> - `src/admin/styles.css` (design tokens + komponen CSS)
> - `src/admin/index.html` (struktur layout & markup)
> - `src/admin/dashboard.ts` (behavior, state, data fetching)
>
> Semua nilai di bawah adalah nilai aktual yang dipakai kode — bukan tebakan.
> Jika ada konflik antara dokumen ini dan gambar referensi, dokumen ini yang
> menang untuk konsistensi implementasi.

---

## 1. GLOBAL DESIGN

**Theme: LIGHT.** Dilarang memakai dark theme sebagai tema utama.

| Aspek | Nilai |
|---|---|
| Background halaman | `#f6f8fb` (abu kebiruan sangat terang) |
| Surface / card | `#ffffff` |
| Surface sekunder (input, table head, inner panel) | `#f8fafd` |
| Primary blue | `#2563eb` |
| Primary hover | `#1d4fd7` |
| Text utama (heading/body) | `#14213d` (dark navy) |
| Text sekunder | `#5b6b84` |
| Text tersier/dim (metadata, placeholder) | `#8a97ac` |
| Border standar | `#e3e8f0` |
| Border tipis (divider internal card) | `#eef1f7` |
| Success (ENABLED / operational) | text `#15803d`, bg `#ecfdf3`, border `#bbe9cb` |
| Danger (DISABLED / error / delete) | text `#dc2626`, bg `#fef2f2`, border `#f5c6c6` |
| Warning | text `#b45309`, bg `#fffbeb`, border `#f2dfb4` |
| Info | text/bg `#2563eb` / `#eaf1fe`, border `#c4d8fb` |
| Blocked (status log) | text `#9333ea`, bg `#faf5ff`, border `#e4ccf8` |

- **Shadow** sangat ringan, tidak ada glow:
  - `--shadow-sm: 0 1px 2px rgba(20,33,61,.05)` (card default)
  - `--shadow:    0 2px 8px rgba(20,33,61,.07)` (hover)
  - `--shadow-lg: 0 12px 32px rgba(20,33,61,.14)` (modal, drawer)
- **Border radius:** `14px` (card/modal/login), `10px` (input kecil, panel dalam), `8px` (button/input/badge-square). Pill = `999px`.
- **Typography hierarchy:**
  - Base body: `14px / line-height 1.55`, font sans system stack.
  - Page/section title: `16px w600`, letter-spacing `-0.1px`.
  - Card title: `15–16px w600/700`.
  - Body/table cell: `13px`.
  - Metadata/label: `10–12px`, uppercase, letter-spacing `0.5–0.8px`, warna muted.
  - Angka data: font mono stack, tabular.
  - Font stacks:
    - sans: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`
    - mono: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace`

Dilarang: gradient berlebihan, efek glow, background gelap.

---

## 2. PAGE LAYOUT

```
┌────────────┬──────────────────────────────────────────┐
│            │ TOPBAR (sticky, h ≥ 58px)                 │
│  SIDEBAR   ├──────────────────────────────────────────┤
│  248px     │ MAIN CONTENT                              │
│  sticky    │ max-width 1400px, centered                │
│  full-h    │ padding 24px 24px 48px                    │
└────────────┴──────────────────────────────────────────┘
```

Nilai konkret:

| Elemen | Nilai |
|---|---|
| Sidebar width | `248px` (`--sidebar-width`), sticky `top:0`, tinggi viewport penuh |
| Header (topbar) height | `min-height 58px`, `position: sticky; top: 0; z-index 30` |
| Content max width | `1400px`, margin auto |
| Content padding | `24px` atas/samping, `48px` bawah; mobile: `16px 12px 24px` |
| Gap antar card | `24px` (`margin-bottom` card) |
| Grid provider gap | `16px` |
| Shell | flexbox; `.app-shell { display:flex; min-height:100vh }`; kolom kanan `flex:1; min-width:0` |

Responsive shell:
- `>1024px`: sidebar terlihat permanen; toggle → collapse via `margin-left:-248px`.
- `≤1024px`: sidebar jadi off-canvas drawer fixed kiri (`margin-left:-248px`, muncul dengan class `.is-sidebar-open` + overlay `rgba(20,33,61,.4)` z-index 35).

---

## 3. SIDEBAR

Posisi: kiri, sticky, satu layar penuh, scroll sendiri pada area menu.

| Bagian | Spesifikasi |
|---|---|
| Background | `#ffffff` |
| Border kanan | `1px solid #e3e8f0` |
| Branding (atas) | logo square `38×38px`, radius 10, bg `#eaf1fe`, border `#c4d8fb`, icon biru; judul `nvidia-api` 15px w700 navy; subjudul `ADMIN DASHBOARD` 10px uppercase letterspacing .8 muted |
| Padding branding | `24px 16px 16px` |
| Menu | vertical list, gap 2px, padding sisi `12px` |
| Menu item | button full-width, `padding 9px 12px`, radius 8, font `13px w500`, border-kiri `3px transparent`, ikon `16×16` + label, teks muted |
| Hover | text navy, bg `#f6f8fb` |
| **Active** | text & icon **blue `#2563eb`**, bg **light blue `#eaf1fe`**, border-left `3px #2563eb`, font w600 |
| Focus-visible | `outline: 2px solid #2563eb; offset 1px` |
| System status card (bawah) | bg `#f8fafd`, border `#e3e8f0`, radius 10, padding 12; judul "SYSTEM STATUS" 11px uppercase muted; baris status dot hijau `8px` + ring `box-shadow 0 0 0 3px #ecfdf3` + "Operational" 13px w600; baris `Uptime → 7d 14h 32m` (label dim, value mono). Data WAJIB dari `/internal/health`, dilarang hardcode. |
| Version footer | `© {tahun} nvidia-api · v{version}` 11px dim, center; versi dari backend (`/internal/health.version` ← package.json), tahun dari `Date.now()` |

**Daftar menu (target lengkap):**

| # | Label | Status implementasi |
|---|---|---|
| 1 | Overview | ✅ tab `overview` |
| 2 | Providers | ✅ tab `providers` (Provider Management) |
| 3 | API Key Management | ⚠️ via modal "Manage API Keys" dari provider card (bukan tab terpisah) — pola sesuai reference |
| 4 | Model Registry | ✅ tab `registry` |
| 5 | Usage Dashboard | ✅ tab `providers-usage` + `models-usage` (+ summary cards di Overview) |
| 6 | Usage Logs | ✅ tab `logs` |
| 7 | Pricing Management | ✅ tab `pricing` |
| 8 | Backup & Restore | ✅ tab `backup` |
| 9 | System Settings | ❌ belum ada — butuh API settings di backend sebelum UI dibuat (jangan fake) |

Icon style: inline SVG stroke `currentColor`, `stroke-width 2`, round cap/join, ukuran 16×16 di menu. Warna mengikuti state teks (muted → blue saat aktif).

---

## 4. HEADER (Topbar)

Satu baris flex, `justify-content: space-between`, gap 16px, wrap di layar sempit. Background putih, border-bawah `1px #e3e8f0`.

**Kiri (context):**
1. **Sidebar toggle** — icon-only button `34×34px`, radius 8, border `#e3e8f0`, ikon hamburger 18px, hover bg `#f6f8fb`. Aria-label `Toggle sidebar`. Desktop = collapse; mobile = drawer.
2. **Breadcrumb** — `Admin › {Nama Section}`; root & separator `13px` dim, current `13px w600` navy, ellipsis jika panjang. Current disinkronkan otomatis dengan tab aktif.

**Kanan (global controls):**
3. **Search** — input pill (`border-radius 999px`), lebar `220px` (150px mobile), bg `#f6f8fb`, icon search absolut kiri, `<kbd>Ctrl K</kbd>` absolut kanan (mono 10px, border tipis, sembunyi ≤768px). Shortcut global: Ctrl/Cmd+K fokus ke input. Perilaku: tab Providers = filter live; tab lain + Enter = lompat ke Usage Logs dengan query.
4. **Refresh** — compact ghost button (`btn--sm`): icon refresh 14px + label "Refresh"; disabled saat fetch; mobile: hanya icon. Di sebelahnya `#last-refresh` (mono 11px dim).
5. **System status pill** — `● Operational`: dot hijau + teks hijau, pill bg `#ecfdf3` border `#bbe9cb`; kondisi down berubah merah. Mobile ≤640px: teks disembunyikan, hanya dot.
6. **Admin profile** — avatar lingkaran `32px` biru solid huruf "A" putih + meta dua baris (`admin` 12px w600 / `Administrator` 10px dim); mobile: meta disembunyikan.

**Navigation rule:** topbar TIDAK berisi menu navigasi halaman. Navigasi hanya di sidebar.

---

## 5. PROVIDER MANAGEMENT

Struktur section (tab `providers`):

```
┌─ Card ────────────────────────────────────────────────┐
│ Provider Management                    [+ Add Provider]│
│ Manage and configure your AI providers and their      │
│ API connections.                                       │
│                                                        │
│ ┌─ Card ─┐  ┌─ Card ─┐  ┌─ Card ─┐                    │
│ │Provider│  │Provider│  │Provider│   ← grid 3 kolom    │
│ └────────┘  └────────┘  └────────┘                     │
└────────────────────────────────────────────────────────┘
 ⓘ Click on "Manage API Keys" to view and manage the API
   keys for each provider.
```

- **Page title:** `Provider Management`, 16px w600 navy.
- **Subtitle:** `Manage and configure your AI providers and their API connections.` 12px muted.
- **Add Provider button:** primary blue, compact (`btn--sm`), icon plus 14px + label, rata kanan header card. Karena admin API belum punya create-provider endpoint, klik menampilkan dialog informatif (bukan form palsu).
- **Grid:** `.providers-list`
  - Desktop `>1100px`: **3 kolom** `repeat(3, minmax(0,1fr))`, gap 16px.
  - Tablet `≤1100px`: **2 kolom**.
  - Mobile `≤720px`: **1 kolom**.
- Card tinggi mengikuti konten, actions menempel bawah via `margin-top:auto`.
- **Info bar** di bawah grid (di luar card): bg `#eaf1fe`, border `#c4d8fb`, radius 10, padding `12px 16px`, icon info 15px biru, teks 13px navy.

---

## 6. PROVIDER CARD

`.provider-card`: putih, border `1px #e3e8f0`, radius 14, shadow-sm, padding 16, flex column gap 12. Hover: border `#c4d8fb` + shadow sedang. Disabled state: opacity .75.

```
┌─────────────────────────────────────────┐
│ [icon] Provider Name          ● ENABLED │ ← header
│        id: provider-id                  │
│ ┌─────────┬──────────┬──────────┐       │
│ │ ▣ 1050  │ 🔑 9     │ ⚡ 1800   │       │ ← statistik
│ │ MODELS  │ API KEYS │ REQUESTS │       │   (divider atas+bawah)
│ └─────────┴──────────┴──────────┘       │
│ 9 of 1050 models routable               │ ← hint 12px muted
│ [Manage API Keys] [Disable]   ▾ models  │ ← actions (bawah)
└─────────────────────────────────────────┘
```

**Header (atas, flex space-between):**
- Icon/avatar kiri: square `40×40px`, radius 10, bg `#eaf1fe`, border `#c4d8fb`, huruf pertama nama provider uppercase biru 16px w700 (fallback konsisten; tidak membuat logo trademark palsu).
- Nama provider: `15px w700` navy, ellipsis.
- Domain/id: `id: {providerId}` mono `11px` dim, ellipsis.
- Status badge kanan-atas: `● ENABLED` — pill hijau (bg `#ecfdf3`, text `#15803d`, border `#bbe9cb`) atau `● DISABLED` merah.

**Statistics row (tengah, divider `1px #eef1f7` atas & bawah, padding-y 12):**
Tiga stat sejajar (`flex:1` each), tiap stat = icon tile `30×30` radius 8 + value mono `15px w700` + label uppercase `10px` dim:
- Models — icon cube, tile biru (`#eaf1fe`/`#2563eb`)
- API Keys — icon key, tile biru
- Requests — icon lightning, tile **hijau** (`#ecfdf3`/`#15803d`)

Semua angka REAL dari backend (`/admin/providers` + `/admin/usage/providers`). Jika belum ada data → tampilkan `—`, dilarang mengarang angka.

**Actions row (bawah, `margin-top:auto`, wrap):**
- `Manage API Keys` — outline blue (`btn--ghost`): border `#e3e8f0`, teks muted, hover → biru + bg light-blue. Membuka modal keys (masked only).
- `Disable` — tinted danger (`btn--danger`): bg `#fef2f2`, teks `#dc2626`, border `#f5c6c6`. **Bukan solid red.** Selalu melalui confirm dialog. Disable tidak menghapus data apa pun.
- `Enable` (provider disabled) — tinted success (`btn--success`): bg `#ecfdf3`, teks `#15803d`, border `#bbe9cb`.
- Model count kanan (`margin-left:auto`): toggle biru 12px `▾ N models`, klik expand daftar model mono 11px (scroll max-height 220px).

---

## 7. COLOR TOKENS

Definisi di `:root` (`src/admin/styles.css`) — gunakan token ini, jangan hardcode hex baru:

```css
--color-bg:             #f6f8fb;
--color-bg-elev:        #ffffff;
--color-surface:        #ffffff;
--color-surface-2:      #f8fafd;
--color-border:         #e3e8f0;
--color-border-light:   #eef1f7;

--color-text:           #14213d;  /* primary */
--color-text-muted:     #5b6b84;  /* secondary */
--color-text-dim:       #8a97ac;  /* tertiary */

--color-primary:        #2563eb;
--color-primary-hover:  #1d4fd7;
--color-primary-light:  #eaf1fe;  /* alias --color-primary-bg */
--color-primary-border: #c4d8fb;

--color-success:        #15803d;
--color-success-light:  #ecfdf3;  /* alias --color-success-bg */
--color-success-border: #bbe9cb;

--color-danger:         #dc2626;  /* alias --color-error */
--color-danger-light:   #fef2f2;  /* alias --color-error-bg */
--color-error-border:   #f5c6c6;

--color-warn:           #b45309;
--color-warn-bg:        #fffbeb;
--color-warn-border:    #f2dfb4;

--color-info:           #2563eb;
--color-info-bg:        #eaf1fe;
--color-info-border:    #c4d8fb;

--radius:    14px;   /* card, modal, login */
--radius-sm: 10px;   /* panel dalam, avatar */
--radius-xs: 8px;    /* button, input */
```

---

## 8. BUTTONS

Base `.btn`: inline-flex center, gap 8px, `font: inherit; 13px w600`, `min-height 34px`, `padding 7px 14px`, radius 8, white-space nowrap, transition 150ms. Disabled: opacity .45, cursor not-allowed. Focus-visible: outline 2px biru offset 1px.

| Variant | Default | Hover |
|---|---|---|
| **Primary** `.btn--primary` | bg+border `#2563eb`, teks putih | bg `#1d4fd7` + ring `0 0 0 2px rgba(37,99,235,.22)` |
| **Secondary/Ghost** `.btn--ghost` | transparan, teks muted, border `#e3e8f0` | teks+border biru, bg `#eaf1fe` |
| **Danger (tinted)** `.btn--danger` | bg `#fef2f2`, teks `#dc2626`, border `#f5c6c6` | bg `#fde3e3`, border `#dc2626` |
| **Success (tinted)** `.btn--success` | bg `#ecfdf3`, teks `#15803d`, border `#bbe9cb` | bg `#dcf5e6`, border `#15803d` |
| **Icon-only** | pakai `.btn--ghost` / `.topbar__toggle` 34×34 | aria-label/title **wajib** |

Ukuran:
- `.btn--sm`: `min-height 30px`, padding `5px 12px`, font 12px.
- `.btn--xs`: `min-height 28px`, padding `4px 10px`, font 12px (aksi dalam tabel/card).
- Active (pressed): tidak ada style khusus selain hover state; disabled seperti di atas.

Aturan: aksi destruktif (Delete/Restore/Disable) SELALU tinted-outline + confirm modal, bukan solid red.

---

## 9. BADGES

`.badge`: inline-flex, gap 5px, `padding 3px 10px`, pill `999px`, font `11px w700`, uppercase, letter-spacing .5, border 1px, **dot 6px `currentColor`** via `::before`.

| Badge | Warna (text/bg/border) |
|---|---|
| ENABLED / VALID / Active | hijau `#15803d` / `#ecfdf3` / `#bbe9cb` |
| DISABLED / INVALID / off | merah `#dc2626` / `#fef2f2` / `#f5c6c6` |
| SUCCESS (log) | sama dengan hijau |
| ERROR (log) | sama dengan merah |
| BLOCKED (log) | ungu `#9333ea` / `#faf5ff` / `#e4ccf8` |
| HTTP 2xx | hijau · HTTP 4xx amber · HTTP 5xx merah · null abu |
| Netral (builtin/provider tag) | `#f8fafd` / muted / `#e3e8f0` |

Status hierarchy: success=hijau, error/disabled=merah, warning=amber, info=biru.

---

## 10. CARDS

`.card`:
- background `#ffffff`, border `1px solid #e3e8f0`, radius `14px`
- shadow `--shadow-sm`, padding `24px`, margin-bottom `24px`
- header: flex baseline space-between, wrap, margin-bottom 24px; title 16px w600 + hint 12px muted
- varian `.card__header--split`: align-items center, untuk title+subtitle kiri vs tombol aksi kanan

Card turunan memakai token yang sama: `.summary-card` (stat usage, surface-2 + border-left 3px warna semantik), `.provider-card` (§6), `.sidebar-status`, `.apikey-row`, panel filter/form (surface-2, radius 10).

Modal `.modal__panel`: putih, radius 14, border, `width min(640px,100%)`, max-height 85vh, shadow-lg, backdrop `rgba(0,0,0,.6)+blur(3px)`. Tutup: tombol ×, klik backdrop, tombol Cancel, dan **Escape**.

---

## 11. TYPOGRAPHY

| Elemen | Style |
|---|---|
| Page/section title (`.card__title`) | 16px, w600, navy, ls −0.1px |
| Subtitle/hint (`.card__hint`) | 12px, w400, muted |
| Card title kecil (`.provider-card__name`, modal title) | 15px, w700, navy |
| Body/table cell | 13px, w400, navy |
| Table header | 10px, w600, UPPERCASE, ls 0.6px, muted |
| Label form | 11px, w600, UPPERCASE, ls 0.5px, muted |
| Metadata (id, timestamp) | 11px mono, dim |
| Nilai angka/statistik | 15–24px mono w700, tabular-nums |
| Button | 13px w600 (xs/sm: 12px) |
| Badge | 11px w700 UPPERCASE ls 0.5px |

---

## 12. ICONS

- **Tanpa icon library eksternal / CDN** — semua icon **inline SVG** (stroke style, feather-like): `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`.
- Ukuran: menu `16×16`, topbar/button `12–18px`, stat tile `15×15`.
- Warna: `currentColor` — ikut warna teks state (muted/blue/green/red).
- Alignment: flex `align-items:center`, `flex-shrink:0`.
- Provider tanpa logo → fallback avatar huruf (§6); jangan membuat logo palsu mirip trademark.

---

## 13. RESPONSIVE

Breakpoints aktual: `1024px` (shell), `1100px` (grid), `720px` (grid), `768px` (spacing/header), `640px` (kompak), `380px` (ekstrem).

| Aspek | Desktop >1024 | Tablet ≤1024 | Mobile ≤720/640 |
|---|---|---|---|
| Sidebar | terlihat; toggle = collapse | drawer off-canvas + overlay | drawer off-canvas; auto-close setelah navigasi |
| Provider grid | 3 kolom | 2 kolom (≤1100) | 1 kolom (≤720) |
| Summary grid | auto-fill min 170px | — | 2 kolom (≤640), 1 kolom ≤380 |
| Header | lengkap | sama | kbd disembunyikan, search 150px, profile-meta & label Refresh disembunyikan, status pill hanya dot |
| Tables | normal | normal | `.table-wrap` horizontal scroll (min-width 720px), font 12px, padding lebih rapat |
| Buttons | normal | normal | filter actions full-width |
| Modal | max 85vh | sama | radius 10, max 90vh |
| Detail list modal | 2 kolom dt/dd | — | 1 kolom, dd bergaris kiri |

Larangan: horizontal overflow di luar `.table-wrap`, card terpotong, tombol keluar layar, teks overlap.

---

## 14. OTHER ADMIN PAGES

Semua halaman WAJIB memakai design system §1–§12 (satu aplikasi, bukan gaya per-halaman):

| Halaman | Pola wajib |
|---|---|
| Overview | summary cards (surface-2 + border-left semantik) + daftar provider ringkas |
| Providers / API Key Management | §5–§6; API keys hanya di modal, **selalu masked** (`sk-••••1234`), input password, raw key tak pernah dirender/disimpan client-side |
| Model Registry | tabel clean: provider badge, model (mono), backend model, priority, status badge, Enable/Disable + Delete berkonfirmasi; form add inline (pola pricing-add) |
| Usage Dashboard | cards Total Requests / Successful / Failed / Blocked / Input / Output / Total Tokens / Avg Latency; hijau=sukses, merah=error, biru=tokens |
| Usage Logs | tabel modern + filter panel (surface-2) + badge status + pagination (25/halaman) |
| Pricing Management | tabel + form add/edit dashed panel, badge enabled/disabled/builtin, edit/toggle/delete |
| Backup & Restore | tombol Create Backup primary, tabel ID/tanggal/records/size/version/status VALID, Restore & Delete wajib confirm |
| System Settings | (future) section cards General/Security/Provider/Usage/System dengan switch + form controls dari design system ini — **hanya setelah ada API settings** |

Empty/error state seragam: `.state-empty` (dashed border muted) / `.state-error` (merah tinted) — tanpa dummy data.

---

## 15. NAVIGATION RULE

- **Sidebar = satu-satunya navigasi halaman** (tab switching, breadcrumb source).
- **Header = global controls saja**: sidebar toggle, breadcrumb, search, refresh, last-refresh, system status, profile.
- Dilarang menambah menu navigasi duplikat di header.
- Breadcrumb otomatis mengikuti tab aktif (`TAB_LABELS` di `dashboard.ts`).

---

## 16. FUNCTIONALITY (non-negotiable)

Redesign UI tidak boleh mengubah business logic maupun API contract:

- Endpoint yang dikonsumsi UI tetap: `/admin/providers` (+PATCH enable/disable), `/admin/providers/:id/api-keys` (CRUD), `/admin/models` (GET/POST/PATCH/DELETE), `/admin/pricing*`, `/admin/logs`, `/admin/usage*`, `/admin/backup*`, `/internal/health`.
- Disable provider ≠ hapus data (usage history & registry dipertahankan).
- Restore backup selalu berkonfirmasi + pre-restore snapshot.
- Raw API key/provider credential tidak pernah ditampilkan — masking saja.
- Semua data tampilan berasal dari backend; tidak ada angka palsu; empty state jika kosong.
- Performance: gunakan API existing, polling 30s hanya saat tab visible & skip tab logs, pagination server-side.

---

## 17. COMPONENT SYSTEM (reusable — gunakan, jangan duplikasi)

Komponen existing yang WAJIB dipakai ulang (semua di `styles.css`, perilaku di `dashboard.ts`):

✅ Sudah tersedia:
- Layout: `.app-shell`, `.sidebar`, `.topbar`, `.app-main`, `.breadcrumb`, `.global-search`, `.profile`, `.status-pill`
- Komponen: `.btn` (+varian/ukuran), `.badge` (+varian), `.card`, `.data-table` + `.table-wrap`, `.filters`, `.pagination`, `.modal` (backdrop/panel/header/body/footer), `.confirm-modal` flow (`openConfirm`), `.infobar`, `.detail-list`, skeleton loading (`.skeleton`, `.skeleton-row`), state (`.state-empty`, `.state-error`, `.error-banner`)
- Util: token warna/radius/shadow/spacing (`--space-1..8`), helper format (`fmtNum`, `fmtTokens`, `fmtCost`, `fmtLatency`, `fmtTime`, `fmtSize`), `esc()` untuk escaping HTML

❌ Belum tersedia (baru boleh dibuat jika benar-benar dibutuhkan, tetap dari token yang sama):
- Komponen chart/grafik (Usage Dashboard saat ini berupa cards + tabel)
- Halaman/tab System Settings (menunggu API settings)
- Toast notification global (saat ini cukup `.error-banner` + `.backup__status`)
- Toggle/switch component (untuk Settings masa depan)

---

## 18. IMPLEMENTATION RULE

- Dokumen ini adalah spesifikasi saja — tidak ada perubahan kode dalam task ini.
- Setiap perubahan UI berikutnya: audit struktur existing → pakai komponen/token di atas → jangan bikin framework/CSS kedua → jangan ubah backend/API/business logic → verifikasi responsive 3 breakpoint → jalankan `npm run lint`, `npm run build`, `npm test` (skip `tests/gorouter.test.ts`).
