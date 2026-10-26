# Tiến độ thực thi

Ngày 26/10/2026, repo GitHub Kintinz/showcase ban đầu trống. Checkout local trên branch chưa có commit `feat/ui-showcase`. Không stage/commit/push, không cài dependency hoặc thay đổi cấu hình dịch vụ.

## Quyết định triển khai

- Dùng Node 24 có sẵn và Web APIs trong Worker; không cài ZIP library. Bộ giải nén chỉ hỗ trợ ZIP thường stored/deflate với giới hạn nêu trong README. Nếu cần hỗ trợ thêm định dạng ZIP, phải mở rộng phạm vi và đánh giá thư viện riêng.
- Module Worker/công cụ dùng đuôi .ts hợp lệ với Node 24 native TypeScript support. Chưa có TypeScript compiler/dependency, do đó kiểm tra hiện tại là runtime tests/syntax, không phải static typecheck.
- Mẫu cấu hình được lưu thành `wrangler.jsonc.example`; chưa tạo config deploy hoạt động hoặc secret. Phiên được mã hóa, GitHub token chỉ ở cookie HttpOnly và backend.
- Cấu trúc metadata vẫn `catalog/{slug}.json`. Danh sách được lọc server-side; repo lớn có chi phí đọc một blob cho mỗi metadata, cần kiểm tra hạn mức trước mở rộng.
- Giai đoạn 1 chưa thể xác minh branch protection, App permission và quota tài khoản vì chưa có GitHub App/Cloudflare configuration. Phần source và mock integration được thực hiện trước, không coi là đã nghiệm thu dịch vụ thật.

## Tiến độ theo kế hoạch

| Task | Trạng thái |
|---|---|
| 1. Điều kiện tích hợp | Clone được repo trống; setup dịch vụ đang chờ |
| 2. Đăng nhập và quyền | Source + unit/API tests; chưa OAuth thật |
| 3. HTML tới xuất bản | Source + mock integration/status tests; chưa commit/deploy thật |
| 4. ZIP | Giải nén, kiểm tra, runtime tests Node; chưa Worker deployed |
| 5. Thư viện/viewer | Source UI; kiểm tra trình duyệt local bằng fixture |
| 6. Xóa | Source, tests và thao tác browser fixture; chưa GitHub/Pages thật |
| 7. Nghiệm thu | Local tests/build/review; E2E trên dịch vụ thật còn thiếu |

Browser fixture dùng tài khoản và repo trong bộ nhớ, tách khỏi bundle Worker. Không dùng kết quả fixture làm bằng chứng quyền hoặc deployment trên GitHub thật.

## Review và sửa lỗi

- Đã có một reviewer độc lập đọc Worker, GitHub adapter, ZIP, quyền sở hữu, UI, builder và workflow; reviewer không sửa source.
- Fixed: cùng slug được xóa rồi upload lại có thể nhận nhầm bản mới là bản cũ đã deploy. Hai phía publish/marker nay dùng uploadId riêng cho mỗi lần tạo; test tái hiện đã fail trước sửa và pass sau sửa.
- Fixed: workflow của commit cũ fail trong khi workflow snapshot mới hơn đang chạy làm UI dừng theo dõi. Status nay kiểm tra workflow mới có chứa commit trước khi quyết định failed; test tái hiện đã fail trước sửa và pass sau sửa.
- Integration bổ sung dùng GitHub HTTP adapter thật với transport giả: kiểm tra JWT RSA, đổi OAuth code, cookie phiên, kiểm tra quyền, upload, commit không force, marker đúng uploadId, thu hồi quyền rồi xóa. Đây vẫn là mock integration, không phải GitHub/Cloudflare E2E thật.
- Không có finding nhỏ nào được reviewer ghi nhận để hoãn.
