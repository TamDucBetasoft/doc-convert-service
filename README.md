# print-convert-service

Dịch vụ chuyển tài liệu Office sang PDF cho app **Smart Printer** (và các app khác của công ty, ví dụ PDF Reader).
Thay thế backend cũ `http://139.180.140.223:8080/convert_to_pdf`.

- **Định dạng:** doc, docx, xls, xlsx, ppt, pptx, odt, ods, odp, rtf
- **Engine:** [Gotenberg](https://gotenberg.dev) (LibreOffice chạy headless), bản `-libreoffice` không kèm Chromium
- **Gateway:** Node.js 22 + TypeScript + Fastify 5, job lưu trong Redis
- **Tương thích ngược:** giữ nguyên `POST /convert_to_pdf` để các bản app đã phát hành vẫn chạy

```
App ──HTTPS──▶ Reverse proxy (Nginx/Cloudflare, TLS)
                    │
                    ▼
               ┌──────────┐   mạng "engine" (internal: không ra internet)
               │ gateway  │──────────────┬───────────────┐
               │ :8080    │              ▼               ▼
               └──────────┘        ┌───────────┐    ┌────────┐
   auth · kiểm file · rate limit   │ gotenberg │    │ redis  │
   cache · hàng đợi · metrics      │ :3000     │    │ :6379  │
                                   └───────────┘    └────────┘
```

---

## Chạy thử trong 5 phút

Yêu cầu: Docker (Docker Desktop, colima hoặc OrbStack).

```bash
cp .env.example .env              # sửa API_KEYS: openssl rand -hex 24
docker compose up -d --build
curl -s localhost:8080/readyz     # {"status":"ready",...}
```

Convert một file:

```bash
npm ci && npm run samples         # tạo samples/generated/*.docx|xlsx|rtf (tiếng Việt + CJK/Arabic/Thai)

KEY=<key của app printer trong .env>
# Async: gửi → hỏi trạng thái → tải về
curl -s -H "x-api-key: $KEY" -F file=@samples/generated/vi-multiscript.docx localhost:8080/v2/jobs
curl -s -H "x-api-key: $KEY" localhost:8080/v2/jobs/<jobId>
curl -s -H "x-api-key: $KEY" localhost:8080/v2/jobs/<jobId>/result -o out.pdf

# Đồng bộ: nhận PDF ngay trong response
curl -s -H "x-api-key: $KEY" -F file=@samples/generated/vi-two-sheets.xlsx localhost:8080/v2/convert -o out.pdf
```

## Phát triển

```bash
npm ci
npm test                          # unit + API test (không cần Docker)
npm run typecheck
GOTENBERG_URL=http://localhost:3000 npm test   # thêm test với Gotenberg thật
npm run dev                       # chạy gateway ngoài Docker (cần Redis + Gotenberg)
```

Để chạy `npm run dev`, mở tạm port của Gotenberg/Redis, ví dụ:
`docker run --rm -p 3000:3000 gotenberg/gotenberg:8.39.0-libreoffice` và `docker run --rm -p 6379:6379 redis:7.4.12-alpine`,
rồi đặt `GOTENBERG_URL=http://localhost:3000 REDIS_URL=redis://localhost:6379 DATA_DIR=./data`.

| Thư mục | Nội dung |
|---|---|
| `src/app.ts` | Dựng Fastify: plugin, error handler, đăng ký route |
| `src/jobService.ts` | Luồng nghiệp vụ: nhận job, cache, idempotency, xử lý, phục hồi sau restart |
| `src/queue.ts` | Hàng đợi trong tiến trình, có giới hạn (backpressure) |
| `src/fileType.ts` | Nhận diện định dạng bằng magic bytes, chặn zip bomb |
| `src/gotenberg.ts` | Client gọi Gotenberg |
| `src/jobStore.ts` | Lưu job/cache/idempotency trong Redis (và bản in-memory cho test) |
| `src/routes/` | `/convert_to_pdf`, `/v2/convert`, `/v2/jobs*`, `/healthz`, `/readyz`, `/metrics` |
| `openapi.yaml` | Đặc tả API đầy đủ |
| `loadtest/convert.js` | Kịch bản k6 |
| `.github/` | CI, phát hành image, Dependabot |

## CI, phát hành và cập nhật thư viện

| File | Chạy khi | Làm gì |
|---|---|---|
| `.github/workflows/ci.yml` | Push lên `main`, mở/cập nhật PR | `typecheck` + toàn bộ test, gồm test với Gotenberg thật; sau đó dựng cả stack Docker và gọi thử `/v2/convert`, `/convert_to_pdf`, kiểm `401` |
| `.github/workflows/release.yml` | Push tag `vX.Y.Z` | Chạy test, rồi build image amd64 + arm64 và đẩy lên `ghcr.io/<owner>/<repo>:X.Y.Z`, `:X.Y`, `:latest` |
| `.github/dependabot.yml` | Thứ Hai hằng tuần | Mở PR nâng npm (gộp minor/patch), Node base image, Gotenberg/Redis trong compose, GitHub Actions |

Phát hành một bản:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Server khi đó chỉ cần `docker pull ghcr.io/<owner>/<repo>:0.1.0` thay cho `build: .` trong compose.
Image trên ghcr.io mặc định là private, nên server cần `docker login ghcr.io` bằng token có quyền `read:packages`.

Thiết lập cần bật tay trong GitHub (Settings, quyền admin):
- **Branches → Branch protection** cho `main`: bắt buộc qua PR, bắt buộc check `Typecheck and test` và `Docker stack smoke test` xanh.
- **Code security**: bật *Dependabot alerts* và *Dependabot security updates*.
- **Collaborators**: thêm CTO, hoặc chuyển repo sang organization của công ty.
- **Actions → General**: giữ quyền mặc định của `GITHUB_TOKEN` là read; workflow release tự xin `packages: write`.

---

## API tóm tắt

Chi tiết: [`openapi.yaml`](openapi.yaml). Mọi response có header `x-request-id`, dùng khi báo lỗi.

| Endpoint | Auth | Mô tả |
|---|---|---|
| `POST /v2/jobs` | `X-Api-Key` | Multipart field `file`. Trả `202 {jobId, status:"queued", pollAfterMs}`; `200` nếu trúng cache |
| `GET /v2/jobs/{id}` | `X-Api-Key` | `queued` / `processing` / `done` (+`pageCount`) / `failed` (+`error`) |
| `GET /v2/jobs/{id}/result` | `X-Api-Key` | PDF; `409` chưa xong, `410` đã hết hạn, `422` convert lỗi |
| `DELETE /v2/jobs/{id}` | `X-Api-Key` | Xoá job và PDF ngay |
| `POST /v2/convert` | `X-Api-Key` | Đồng bộ, trả PDF trong response |
| `POST /convert_to_pdf` | không | **Hợp đồng cũ**, giữ cho app đã phát hành. Tắt bằng `LEGACY_ENDPOINT_ENABLED=false` |
| `GET /healthz` · `/readyz` · `/metrics` | — | Sống · sẵn sàng (Redis + Gotenberg) · Prometheus |

Header tuỳ chọn:
- `X-Device-Id`: id cố định theo lượt cài app. Job chỉ người có cùng id đọc được; giới hạn lượt tính theo thiết bị thay vì theo IP.
- `Idempotency-Key`: gửi lại cùng key thì nhận lại job cũ, không convert hai lần.

Mã lỗi (`{"code","message"}`; client rẽ nhánh theo `code`, không theo `message`):

| HTTP | `code` | App nên làm gì |
|---|---|---|
| 400 | `file_missing`, `bad_request` | Lỗi phía app, log lại |
| 401 | `unauthorized` | Sai API key / key bị thu hồi |
| 404 | `job_not_found` | Job hết hạn hoặc không thuộc thiết bị này, gửi lại file |
| 409 | `job_not_ready` | Hỏi trạng thái tiếp |
| 410 | `result_expired` | Gửi lại file |
| 413 | `file_too_large` | Báo "file quá lớn" |
| 415 | `unsupported_format` | Báo "định dạng không hỗ trợ / file có mật khẩu" |
| 422 | `archive_rejected`, `conversion_failed` | Báo "file bị hỏng, không đọc được" |
| 429 | `rate_limited` | Đợi `Retry-After` giây |
| 503 | `queue_full`, `engine_unavailable`, `interrupted` | Thử lại sau `Retry-After` |
| 504 | `conversion_timeout` | File quá phức tạp; cho thử lại một lần |

---

## Cấu hình (biến môi trường)

Xem đầy đủ trong [`.env.example`](.env.example). Các con số mặc định là **điểm khởi đầu**, cần chỉnh theo số liệu thật.

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `API_KEYS` | — | `appId:key,appId:key`; key ≥ 24 ký tự. Mỗi app một key để đo và thu hồi riêng |
| `LEGACY_ENDPOINT_ENABLED` | `true` | Bật `/convert_to_pdf` không cần key |
| `TRUST_PROXY` | `false` | Đặt IP/CIDR của reverse proxy, nếu không rate limit sẽ thấy IP của proxy |
| `METRICS_TOKEN` | rỗng | Bearer token cho `/metrics` |
| `MAX_FILE_BYTES` | 20 MB | Giới hạn upload |
| `ZIP_MAX_UNCOMPRESSED_BYTES` / `ZIP_MAX_ENTRIES` / `ZIP_MAX_RATIO` | 200 MB / 5000 / 100 | Chống zip bomb |
| `WORKER_CONCURRENCY` | 2 | Số job convert cùng lúc. Gợi ý: số bản Gotenberg × 2 |
| `QUEUE_MAX_PENDING` | 50 | Quá số này thì trả `503 queue_full` |
| `GOTENBERG_TIMEOUT_MS` | 60 s | Quá thì huỷ và trả `conversion_timeout` |
| `SYNC_WAIT_MS` | 90 s | Endpoint đồng bộ chờ tối đa |
| `RESULT_TTL_SECONDS` | 1 h | Thời gian giữ job và PDF |
| `CACHE_ENABLED` | `true` | Tắt khi chạy load test |
| `XLSX_PRINT_FIXES` | `true` | Chuẩn bị file `.xlsx` trước khi in (xem mục "Excel" bên dưới). Tắt để quay về convert nguyên bản |
| `XLSX_PREP_MAX_BYTES` | 64 MB | File `.xlsx` giải nén lớn hơn mức này thì bỏ qua bước chuẩn bị, convert nguyên bản |

### Excel: chuẩn bị trước khi in (`src/xlsxPrep.ts`)

LibreOffice in file Excel khác cách người dùng thấy trong Excel / Google Sheets ở hai chỗ, nên gateway sửa file `.xlsx` trước khi gửi Gotenberg:

| Vấn đề (đo trên file thật) | Cách xử lý | Không làm khi |
|---|---|---|
| Sheet không đặt vùng/tỉ lệ in → cột bị cắt sang trang khác (bảng 10 cột: **62 → 8 trang**) | Đặt "vừa chiều ngang trang" (`fitToWidth=1`, `fitToHeight=0`); sheet rộng hơn khổ A4 dọc thì chuyển **khổ ngang** | Sheet đã có `fitToPage` hoặc `scale` riêng của người tạo |
| File từ Google Sheets có hàm LibreOffice không có (`IMAGE`, `GOOGLEFINANCE`…) → in ra `#NAME?` | In **giá trị đã lưu trong file** (đúng cái người dùng thấy) thay vì tính lại công thức | Bất kỳ công thức nào trong sheet thiếu giá trị lưu sẵn (file sinh bằng openpyxl…) → giữ nguyên mọi công thức của sheet đó |

Đánh đổi đã biết: sheet cực rộng (ví dụ bảng ảnh trải ngang hàng chục cột) bị thu nhỏ cho vừa 1 trang ngang nên chữ/ảnh rất nhỏ; trước đây sheet đó bị cắt thành nhiều trang. Hàm thay đổi theo thời gian (`TODAY()`, `NOW()`) in ra giá trị lúc lưu file. Chỉ áp dụng `.xlsx` (`.xls` đời cũ là định dạng nhị phân, không sửa).

Mỗi lần đổi logic chuẩn bị/convert khiến cùng một file ra PDF khác: tăng `CONVERSION_REVISION` trong `src/jobService.ts` để cache không trả PDF cũ.
| `RATE_LIMIT_UPLOAD_MAX` / `RATE_LIMIT_POLL_MAX` | 30 / 240 | Giới hạn mỗi **thiết bị** (`X-Device-Id`) trong 1 cửa sổ; request không gửi id thì bỏ qua lớp này |
| `RATE_LIMIT_IP_UPLOAD_MAX` / `RATE_LIMIT_IP_POLL_MAX` | 120 / 600 | **Trần mỗi IP**, cộng dồn mọi endpoint upload (hoặc hỏi trạng thái). Chặn client đổi device id liên tục; là giới hạn duy nhất của `/convert_to_pdf`. Để cao hơn mức thiết bị vì nhà mạng di động (CGNAT) cho nhiều máy chung 1 IP |
| `RATE_LIMIT_WINDOW_MS` | 60 s | Cửa sổ đếm cho cả hai lớp |

---

## Triển khai production — checklist

1. **Domain + HTTPS.** Ví dụ `convert.<congty>.com`. Không dùng IP trần, không dùng HTTP.
   Let's Encrypt chỉ có hạn 90 ngày; nhớ cài tự gia hạn (certbot timer, Caddy, hoặc Cloudflare).
2. **Reverse proxy.** Giới hạn và timeout phải **lớn hơn** của gateway, nếu không lỗi sẽ đến từ proxy:
   ```nginx
   server {
     listen 443 ssl http2;
     server_name convert.example.com;
     client_max_body_size 25m;        # mặc định Nginx chỉ 1m → 413 trước khi tới gateway
     proxy_read_timeout 120s;         # > SYNC_WAIT_MS
     proxy_send_timeout 120s;
     proxy_request_buffering off;     # stream upload thẳng vào gateway
     location / {
       proxy_pass http://127.0.0.1:8080;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
     location /metrics { deny all; }  # chỉ cho Prometheus nội bộ
   }
   ```
   Cloudflare bản free cắt request sau 100 s và giới hạn upload 100 MB.
   Đặt `TRUST_PROXY` cho đúng địa chỉ proxy.
3. **Secrets.** Sinh key bằng `openssl rand -hex 24`. Để trong `.env` trên server hoặc secret manager, **không commit**.
   Gateway sẽ không khởi động ở production nếu key vẫn là `CHANGE_ME`.
4. **Firewall.** Chỉ mở 443 (và 22 cho SSH bằng key, tắt đăng nhập mật khẩu). Không mở 3000/6379 ra ngoài.
5. **Ổ đĩa.** `convert-data` chứa file tạm và PDF tối đa khoảng 2 × TTL; theo dõi dung lượng. Cấu hình xoay vòng log của Docker
   (`/etc/docker/daemon.json`: `"log-opts": {"max-size": "10m", "max-file": "5"}`).
6. **Cảnh báo tối thiểu.** Uptime check vào `/readyz`; cảnh báo khi:
   - tỉ lệ `pcs_conversions_total{result!="done"}` > 5%,
   - `pcs_queue_depth` cao kéo dài,
   - ổ đĩa > 80%.
7. **Cập nhật bản vá.** Pin version image (đã pin), nâng định kỳ hằng tháng; LibreOffice có lỗ hổng mới thường xuyên.
8. **Quyền riêng tư.** File người dùng chỉ lưu tối đa `RESULT_TTL_SECONDS` (PDF) và bị xoá ngay sau khi convert (file gốc).
   Không log tên file. Cập nhật Privacy Policy + mục Data safety trên Google Play: *tài liệu được tải lên để chuyển đổi,
   không lưu trữ lâu dài, không chia sẻ*. App có người dùng EEA nên cần ghi rõ vị trí đặt server.

### Mở rộng

- **Một máy:** tăng `WORKER_CONCURRENCY` và RAM. Mỗi tiến trình LibreOffice dùng khoảng 300–800 MB khi convert.
- **Nhiều bản Gotenberg:** `docker compose up -d --scale gotenberg=3` (Docker DNS chia tải theo round-robin), đặt `WORKER_CONCURRENCY=6`.
- **Nhiều máy gateway:** hiện mỗi gateway tự xử lý job nó nhận; Redis dùng chung nên máy nào cũng trả lời được trạng thái job,
  nhưng `convert-data` phải là ổ dùng chung (NFS/EFS) hoặc chuyển sang S3/MinIO. Bước tiếp theo khi cần: hàng đợi dùng chung (BullMQ trên Redis).

Ước tính ban đầu (cần đo bằng `loadtest/convert.js`): một file Word vài trang mất khoảng 1–3 s;
1 vCPU cho Gotenberg xử lý khoảng 20–40 file/phút.

---

## Chuyển từ server cũ sang

1. Deploy service này trên domain mới, bật `LEGACY_ENDPOINT_ENABLED=true`.
2. Kiểm tra contract cũ: `curl -F file=@samples/generated/vi-multiscript.docx https://<domain>/convert_to_pdf -o x.pdf`.
3. App bản mới đọc base URL từ Firebase Remote Config, chuyển dần 10% → 50% → 100%.
   So `pcs_conversions_total` với số liệu app (event convert thành công/thất bại).
4. Trỏ IP cũ `139.180.140.223:8080` sang service mới (DNS/reverse proxy trên máy cũ), hoặc giữ máy cũ đến khi bản app cũ còn < 5% người dùng.
5. Khi bản app cũ đã hết: `LEGACY_ENDPOINT_ENABLED=false`.

## Tích hợp phía app Android (gợi ý)

- Base URL lấy từ Remote Config; `BuildConfig` chỉ làm giá trị dự phòng.
- Gửi `X-Api-Key`, `X-Device-Id` (UUID sinh 1 lần, lưu DataStore), `Idempotency-Key` (UUID mỗi lần bấm convert).
- Hỏi trạng thái theo `pollAfterMs`, giãn dần đến khoảng 3 s, tối đa khoảng 90 s; lưu `jobId` để mở lại app vẫn lấy được kết quả.
- Retry `429/503` theo `Retry-After`, cộng thêm độ trễ ngẫu nhiên (jitter) để tránh hàng nghìn máy retry cùng lúc.
- Map `code` sang chuỗi đã dịch (17 locale); log analytics với `code`, `format`, kích thước, thời gian.

---

## Bảo mật — những gì đã có và chưa có

Đã có:
- Nhận diện định dạng thật bằng magic bytes, không tin đuôi file.
- Chặn zip bomb bằng central directory (không giải nén).
- Gotenberg nằm trên mạng `internal` (không ra internet), chạy `no-new-privileges`, `/tmp` là tmpfs.
- Gateway chạy user `node`, filesystem read-only.
- `jobId` là UUIDv4, gắn với app và thiết bị.
- So sánh key theo thời gian hằng (timing-safe).
- Log che `x-api-key` và `authorization`.

Giới hạn cần biết:
- **API key nằm trong APK nên có thể bị trích ra.** Nó chặn bot quét bừa, không chặn kẻ tấn công có chủ đích.
  Lớp mạnh hơn: Play Integrity API (kế hoạch giai đoạn 2).
- `X-Device-Id` do client tự khai: đổi id liên tục né được giới hạn theo thiết bị nhưng vẫn vướng **trần theo IP**; kẻ có nhiều IP (botnet, proxy xoay vòng) thì cần lớp chặn ở Cloudflare/Nginx hoặc Play Integrity.
  `QUEUE_MAX_PENDING` vẫn bảo vệ năng lực xử lý; Play Integrity sẽ giải quyết triệt để.
- Kích thước khai trong zip có thể bị làm giả; chốt chặn cuối là `mem_limit` của container Gotenberg và timeout.
- Endpoint cũ `/convert_to_pdf` không có key (bắt buộc để không làm vỡ app cũ); chỉ được bảo vệ bằng giới hạn lượt theo IP.

## Lộ trình

- [ ] Play Integrity token cho `/v2/*`
- [ ] Lưu file trên S3/MinIO + hàng đợi dùng chung (BullMQ) để chạy nhiều gateway
- [ ] Bộ file mẫu thật (Word nhiều cột, SmartArt, Excel có merge cell, PowerPoint) trong `samples/real/` + so sánh số trang
- [ ] Dashboard Grafana mẫu
