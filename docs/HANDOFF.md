# Bàn giao: doc-convert-service

Dịch vụ chuyển Office → PDF thay cho server cũ `http://139.180.140.223:8080/convert_to_pdf` (HTTP thường, không xác thực).
Người viết: team app Smart Printer. Người vận hành dự kiến: CTO.
Chi tiết kỹ thuật: [`README.md`](../README.md) · hợp đồng API: [`openapi.yaml`](../openapi.yaml).

## 1. Trạng thái: chạy được, chưa deploy

| | |
|---|---|
| Thay được server cũ chưa? | **Có về chức năng.** Endpoint `POST /convert_to_pdf` giữ nguyên hợp đồng cũ — bản app Smart Printer đang phát hành dùng được, không cần ra bản mới |
| Đã chạy production chưa? | **Chưa.** Cần chỗ deploy, domain, HTTPS (mục 3) |
| Kiểm thử | 47 test tự động (gồm Gotenberg thật) + CI dựng cả stack Docker trên mỗi push — xanh |

## 2. Đã kiểm chứng (2026-11-03)

| Mức | Kết quả |
|---|---|
| App Smart Printer thật (TECNO Android 16, realme Android 15, Moto Android 14) | Word / Excel → preview → hộp thoại in hệ thống (máy Brother DCP-T720DW) |
| File thật | Luận văn tiếng Việt 6,7 MB (31 trang, Word ghi 29), SRS 18 MB / 44 ảnh, PowerPoint 17 MB / 34 slide: đúng nội dung, đúng tiếng Việt |
| Excel | Sửa ở gateway: bảng rộng **62 → 8 trang**; file Google Sheets hết `#NAME?` (**21 → 7 trang**) |
| Lỗi đầu vào | > 20 MB → 413 · có mật khẩu → 415 · file hỏng → 422 · zip bomb → 422 · bytes rác → 415 |
| Tải nhẹ | 12 request song song đều OK; file nhỏ 0,2–0,5 s, file lớn 1,5–9,4 s |

## 3. CTO cần quyết

| # | Câu hỏi | Ghi chú |
|---|---|---|
| 1 | **Deploy ở đâu?** (VPS / AWS / GCP / k8s) | Cần ≥ 2 vCPU, 4 GB RAM cho 1 gateway + 1 Gotenberg. Image build sẵn: push tag `vX.Y.Z` → `ghcr.io/<owner>/doc-convert-service` |
| 2 | **Domain + HTTPS** | Checklist Nginx (`client_max_body_size`, timeout, `TRUST_PROXY`) ở README mục "Triển khai production" |
| 3 | **Ai nhận cảnh báo khi sập?** | Đã có `/readyz` và `/metrics` (Prometheus); chưa nối vào hệ thống giám sát nào |
| 4 | **Giữ repo ở đâu?** | Đang ở tài khoản `TamDucBetasoft` (private) → nên chuyển sang organization công ty |
| 5 | **Font VNI / TCVN3** (văn bản hành chính kiểu cũ) | Hiện in ra sai chữ. Sửa = cài font vào image Gotenberg, **cần xác nhận bản quyền** |
| 6 | Hạn mức / chi phí | Đang có rate limit 30/phút/thiết bị + 120/phút/IP; chưa có hạn mức ngày. Ước tính: 1 vCPU Gotenberg ≈ 20–40 file/phút (chưa đo bằng k6) |

## 4. Chuyển từ server cũ (không làm vỡ app đã phát hành)

1. Deploy, `LEGACY_ENDPOINT_ENABLED=true`, thử `curl -F file=@x.docx https://<domain>/convert_to_pdf -o x.pdf`.
2. Trỏ `139.180.140.223:8080` sang server mới bằng reverse proxy trên máy cũ (đây là IP nên không đổi DNS được) **hoặc** chờ bản app mới (bước 3).
3. Bản app mới đọc base URL từ Firebase Remote Config, gửi `X-Api-Key` / `X-Device-Id`, bật dần 10% → 100%.
4. Khi bản app cũ < 5% người dùng: tắt `LEGACY_ENDPOINT_ENABLED`, tắt server cũ.

## 5. Giới hạn đã biết

- LibreOffice không giống Word 100%: lệch 1–2 trang ở tài liệu dài, SmartArt / một số biểu đồ vẽ thiếu, font không có trên server bị thay.
- Excel: chữ có thể đè dòng khi chiều cao dòng lưu trong file nhỏ hơn nội dung; sheet cực rộng bị thu nhỏ cho vừa 1 trang.
- API key nằm trong APK → không phải bảo mật thật; lớp mạnh hơn là Play Integrity (chưa làm). Kẻ có nhiều IP vượt được rate limit → cần Cloudflare / Nginx.
- Mỗi gateway tự xử lý job nó nhận; chạy nhiều gateway cần ổ dùng chung hoặc S3 (README mục "Mở rộng").
- `.xls` / `.doc` đời cũ có mật khẩu trả 422, không phải 415; `.ppt` có mật khẩu chưa thử (mục 7).

## 6. Việc tiếp theo

| Việc | Ai | Ưu tiên |
|---|---|---|
| Deploy + domain + HTTPS + giám sát | CTO | Cao |
| App: hiển thị đúng lỗi convert (413/415/422/503…) thay vì "Lỗi kết nối mạng" | Team app — **xong, đã phát hành** | — |
| App: base URL từ Remote Config, `X-Api-Key`, `X-Device-Id`, API `/v2/jobs`, thử lại theo `Retry-After` | Team app | Cao |
| App: cho chọn PPTX / ODT / RTF (server đã hỗ trợ) | Team app | Trung bình |
| Font OFL còn thiếu (Caudex, Cardo, Poppins, DM Sans, Gelasio thay Georgia) | Backend | Trung bình |
| Nâng Node 22 → LTS mới **một lần** (Dockerfile + CI + `engines` + `@types/node`) — Node 22 hết hỗ trợ 04/2027 | Backend | Trước 04/2027 |
| Đo tải k6 trên server thật | Backend | Cao, trước khi chuyển người dùng thật |
| Hạn mức theo ngày, Play Integrity | Backend | Thấp |

## 7. Kết quả kiểm thử (cập nhật 2026-11-05)

57 test đều đạt trên stack Docker dựng mới, gồm test với Gotenberg thật và `test/stack.e2e.test.ts`. Môi trường đo là máy dev (colima 4 vCPU, 6 GB), không phải server thật, nên các con số chỉ để tham khảo. Bước e2e mới trong CI chưa chạy trên GitHub cho đến khi push.

Đã kiểm chứng:

| Kịch bản | Kết quả |
|---|---|
| Cổng gateway | Mặc định chỉ mở trên `127.0.0.1:8080` |
| `/v2/jobs` trên stack thật | Gửi file, poll, tải PDF, thiết bị khác nhận 404, xoá job, `Idempotency-Key` đều đúng |
| Rate limit với Redis thật | Lần upload thứ 31 nhận 429 kèm `Retry-After`; bộ đếm vẫn còn sau khi restart gateway |
| Kill gateway khi đang có 16 job | Sau khi bật lại, cả 16 job đều xong |
| Kill Gotenberg khi đang có job | `/readyz` báo 503, job lỗi `engine_unavailable`, cả `/v2/convert` và `/convert_to_pdf` trả 503; bật lại là chạy tiếp |
| Redis từ chối ghi hoặc tắt hẳn | Upload trả 500 có `code` và `/readyz` trả 503, đều dưới 5 giây; `/healthz` vẫn sống; Redis về là chạy tiếp |
| 3 Gotenberg, `WORKER_CONCURRENCY=6` | 24 file: 24,6 s còn 12,2 s; tải chia 9/8/7 |
| Kill 1 trong 3 Gotenberg | 12 file đều xong, không job nào lỗi |
| `.doc`, `.xls` có mật khẩu | Trả 422 `conversion_failed` sau khoảng 1 s, không treo |

Lỗi tìm được và đã sửa:
- Khi engine sập, endpoint kết quả và cả `/convert_to_pdf` trả 422 khiến app báo "file hỏng". Giờ trả 503 kèm `Retry-After`.
- Khi Redis tắt, lệnh chờ qua các lần kết nối lại nên upload treo 26,7 s và `/readyz` treo 15,5 s (đo trên GitHub runner, nơi tên `redis` phân giải lỗi rất chậm). Giờ gateway từ chối ngay.

Lỗi đã biết, chưa sửa:
- **Job kẹt khi Redis đầy:** job đang chạy không ghi được trạng thái nên kẹt ở `queued` hoặc `processing` cho đến khi hết TTL (đo được 15/18 job). Job còn file gốc được chạy lại khi restart gateway. App sẽ dừng theo giới hạn poll của mình.
- **Redis lỗi trả 500:** chưa trả 503 kèm `Retry-After`. Rate limit cần Redis nên khi Redis lỗi, mọi upload đều bị từ chối.
- **`.doc`, `.xls` có mật khẩu trả 422** thay vì 415 như file Office mới, nên app chỉ báo chung "file hỏng hoặc có mật khẩu".

Chưa có bằng chứng:

| Hạng mục | Hiện trạng |
|---|---|
| Đo tải | Có `loadtest/convert.js` nhưng chưa chạy; "20–40 file/phút trên 1 vCPU" chỉ là ước tính |
| Production | Chưa chạy thử với domain, HTTPS và Nginx |
| Đầy ổ đĩa | Chưa thử |
| Nhiều gateway | Chưa thử; cần đổi code (mục 8) |
| `.ppt` có mật khẩu | Chưa thử: LibreOffice không mã hoá được `.ppt` nên chưa có file mẫu |
| Phát hành image | Tag `v0.1.0` không có image: `npm ci` của arm64 kẹt khi chạy qua QEMU và job bị huỷ sau 30 phút. Dockerfile đã sửa, chờ bản phát hành kế tiếp để xác nhận image trên ghcr.io |
| App với `/v2` | App chưa tích hợp, các lần thử trên máy thật ở mục 2 đi qua endpoint cũ |

## 8. Vận hành

### Chạy stack

Gồm 3 container: `gateway` (API, cổng 8080), `gotenberg` (LibreOffice, không ra được internet), `redis` (job và bộ đếm rate limit).

```bash
cp .env.example .env              # sửa API_KEYS, sinh key bằng: openssl rand -hex 24
docker compose up -d --build
curl -s localhost:8080/readyz
docker compose ps
docker compose logs -f gateway
```

Gateway mặc định chỉ mở trên `127.0.0.1:8080` để chỉ Nginx cùng máy gọi được, vì Docker publish cổng đi vòng qua `ufw`. Nếu proxy ở máy khác thì đặt `GATEWAY_PORT` và chặn bằng firewall của nhà cung cấp cloud.

Image: build từ source như trên, hoặc push tag `vX.Y.Z` rồi dùng image trên ghcr.io. Nên dùng image theo version để rollback được.

Stage build chạy trên kiến trúc của máy build rồi chép `node_modules` sang image đích, nên chỉ đúng khi dependency production không có module native. Nếu thêm dependency native, phải đổi cách build; job `Build image for amd64 and arm64` trong CI chỉ kiểm tra build được, không kiểm tra module chạy đúng.

### Scale

Dấu hiệu cần scale: `pcs_queue_depth` cao kéo dài, `pcs_conversion_duration_seconds` tăng, nhiều `503 queue_full`.

| Bước | Làm gì | Đổi code? |
|---|---|---|
| 1. Tăng cấu hình máy | Tăng RAM và `WORKER_CONCURRENCY`; nâng cả `mem_limit: 2g` của Gotenberg | Không |
| 2. Nhiều Gotenberg | `docker compose up -d --scale gotenberg=3`, `WORKER_CONCURRENCY=6` (đã thử, mục 7) | Không |
| 3. Nhiều gateway | Ổ dùng chung hoặc S3/MinIO, hàng đợi chung (BullMQ) | **Có** |

Trước bước 3 phải sửa `recover()` trong `src/jobService.ts`: hàm này quét mọi job chưa xong, không phân biệt gateway đang xử lý, nên một gateway restart có thể chạy lại job của gateway khác.

### Xử lý sự cố

| Triệu chứng | Kiểm tra | Xử lý |
|---|---|---|
| `/readyz` lỗi | `docker compose ps`, log của gotenberg và redis | Restart container bị lỗi |
| Nhiều `503 queue_full` | `pcs_queue_depth` | Scale theo bảng trên |
| Nhiều `504 conversion_timeout` | File nào nặng, CPU | Tăng `GOTENBERG_TIMEOUT_MS`, giữ thấp hơn `--api-timeout=90s` |
| Gotenberg khởi động lại liên tục | Có thể hết RAM | Tăng `mem_limit` hoặc giảm `WORKER_CONCURRENCY` |
| Đầy ổ đĩa | Volume `convert-data`, log Docker | Giảm `RESULT_TTL_SECONDS`, bật xoay vòng log |
| Redis đầy | Giới hạn 256 MB, `noeviction` nên không tự xoá key; upload trả 500 | Tăng `--maxmemory`, rồi restart gateway để chạy lại job bị kẹt |
| Redis tắt | `/readyz` báo `redis: false`; upload trả 500 | Bật lại Redis, gateway tự nối lại |
| Lộ API key | Log theo app | Thêm key mới, ra bản app mới, rồi mới thu hồi key cũ; thu hồi sớm làm hỏng bản app đang dùng key đó |

### Việc định kỳ

- **Sao lưu:** gần như chỉ cần giữ `.env`, tài liệu người dùng chỉ lưu tạm. Mất Redis thì job đang chạy mất theo và người dùng phải gửi lại file.
- **Cập nhật:** nâng bản vá hằng tháng. Nếu đổi logic khiến cùng một file ra PDF khác, tăng `CONVERSION_REVISION` để cache không trả PDF cũ.
- **Điểm yếu:** hiện chỉ có một máy, sập là mất dịch vụ convert. Khi app đọc base URL từ Remote Config thì chuyển được sang server dự phòng mà không cần ra bản mới, nếu đã có sẵn server đó.

## 9. Tin nhắn gửi CTO

> Em cần anh deploy doc-convert-service để thay server convert cũ. Tài liệu ở `docs/HANDOFF.md` và README mục "Triển khai production".
>
> **Cần chuẩn bị:** server ≥ 2 vCPU, 4 GB RAM có Docker; một domain HTTPS, ví dụ `convert.<congty>.com`.
>
> **Cần anh quyết:**
> 1. Deploy ở đâu.
> 2. Ai nhận cảnh báo khi server sập.
> 3. Có chuyển repo sang organization công ty không (hiện là repo private ở tài khoản cá nhân).
> 4. Font VNI/TCVN3 có được phép cài không (cần xác nhận bản quyền).
> 5. Hạn mức và chi phí.
> 6. Server đặt ở đâu, để ghi vào Privacy Policy cho người dùng EEA.
>
> **Khi cài:**
> - Chỉ mở cổng 443 và 22; Nginx đặt `client_max_body_size` 25m và timeout 120s.
> - Đặt `TRUST_PROXY` đúng địa chỉ proxy.
> - Bật xoay vòng log Docker.
> - Uptime check vào `/readyz`, chặn `/metrics` từ ngoài.
>
> **Sau khi xong, gửi lại em:** domain và API key cho app printer (qua kênh an toàn), để em đo tải và tích hợp.
>
> **Server cũ:** `139.180.140.223:8080` là IP nên không đổi DNS được. Anh cho em biết có quyền vào máy đó để đặt reverse proxy không; nếu không thì phải đợi bản app mới.
