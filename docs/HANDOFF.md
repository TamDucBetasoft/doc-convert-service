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
2. Trỏ `139.180.140.223:8080` (DNS / reverse proxy trên máy cũ) sang server mới **hoặc** chờ bản app mới (bước 3).
3. Bản app mới đọc base URL từ Firebase Remote Config, gửi `X-Api-Key` / `X-Device-Id`, bật dần 10% → 100%.
4. Khi bản app cũ < 5% người dùng: tắt `LEGACY_ENDPOINT_ENABLED`, tắt server cũ.

## 5. Giới hạn đã biết

- LibreOffice không giống Word 100%: lệch 1–2 trang ở tài liệu dài, SmartArt / một số biểu đồ vẽ thiếu, font không có trên server bị thay.
- Excel: chữ có thể đè dòng khi chiều cao dòng lưu trong file nhỏ hơn nội dung; sheet cực rộng bị thu nhỏ cho vừa 1 trang.
- API key nằm trong APK → không phải bảo mật thật; lớp mạnh hơn là Play Integrity (chưa làm). Kẻ có nhiều IP vượt được rate limit → cần Cloudflare / Nginx.
- Mỗi gateway tự xử lý job nó nhận; chạy nhiều gateway cần ổ dùng chung hoặc S3 (README mục "Mở rộng").
- `.xls` / `.doc` đời cũ có mật khẩu chưa được thử.

## 6. Việc tiếp theo

| Việc | Ai | Ưu tiên |
|---|---|---|
| Deploy + domain + HTTPS + giám sát | CTO | Cao |
| App: hiển thị đúng lỗi convert (413/415/422/503…) thay vì "Lỗi kết nối mạng" | Team app — **đang làm** | Cao |
| App: base URL từ Remote Config, `X-Api-Key`, `X-Device-Id`, API `/v2/jobs`, thử lại theo `Retry-After` | Team app | Cao |
| App: cho chọn PPTX / ODT / RTF (server đã hỗ trợ) | Team app | Trung bình |
| Font OFL còn thiếu (Caudex, Cardo, Poppins, DM Sans, Gelasio thay Georgia) | Backend | Trung bình |
| Nâng Node 22 → LTS mới **một lần** (Dockerfile + CI + `engines` + `@types/node`) — Node 22 hết hỗ trợ 04/2027 | Backend | Trước 04/2027 |
| Hạn mức theo ngày, đo tải k6, Play Integrity | Backend | Thấp |
