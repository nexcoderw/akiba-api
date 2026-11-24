const title = 'Verify your email';
const instructions = 'Enter this code on the Akiba admin sign-in screen.';
const expiration = 'This code expires within 5 minutes. Use the newest code and keep it private.';
const unexpected = 'If you didn’t request this code, you can ignore this email.';

/** The caller validates the six-digit code before interpolating it into HTML. */
export function platformEmailOtpTemplate(code: string) {
	return {
		subject: 'Your Akiba admin email code',
		text: `Akiba Admin\n\n${title}\n\n${instructions}\n\n${code}\n\n${expiration}\n\n${unexpected}`,
		html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${title} | Akiba Admin</title>
  <style>@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&display=swap');</style>
</head>
<body style="margin:0;padding:0;background-color:#FBFAFF;color:#241D32;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#FBFAFF">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#FFFFFF" style="max-width:520px;border:1px solid #E9E2EF;border-radius:20px;">
          <tr>
            <td style="padding:28px 24px 24px;font-family:Outfit,system-ui,-apple-system,'Segoe UI',Arial,sans-serif;">
              <p style="margin:0 0 24px;color:#3E0F8D;font-size:24px;line-height:36px;font-weight:700;letter-spacing:-0.05em;">
                <span aria-hidden="true" style="display:inline-block;width:36px;border-radius:50%;margin-right:10px;background-color:#3E0F8D;color:#FFFFFF;text-align:center;">a</span>akiba<span style="color:#7A47C5;">.</span>
              </p>
              <h1 style="margin:0 0 12px;color:#241D32;font-size:28px;line-height:34px;font-weight:600;">${title}</h1>
              <p style="margin:0 0 20px;color:#655B73;font-size:16px;line-height:24px;">${instructions}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" bgcolor="#EFE7FC" style="border:1px solid #E0D1F6;border-radius:12px;padding:16px;color:#3E0F8D;font-family:Outfit,system-ui,-apple-system,'Segoe UI',Arial,sans-serif;font-size:32px;line-height:40px;font-weight:700;letter-spacing:0.18em;">${code}</td>
                </tr>
              </table>
              <p style="margin:16px 0 0;color:#655B73;font-size:14px;line-height:22px;">${expiration}</p>
              <p style="margin:24px 0 0;border-top:1px solid #E9E2EF;padding-top:16px;color:#655B73;font-size:14px;line-height:22px;">${unexpected}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
	};
}
