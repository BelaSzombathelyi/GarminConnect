export interface ReprocessReportOptions {
    total: number
    processed: number
    failed: Array<{ filePath: string; error: string }>
    warnings: Array<{ filePath: string; count: number }>
    elapsedMs: number
}

function escapeHtml(value: string): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

export function renderReprocessHtml(options: ReprocessReportOptions): string {
    const failedItems = options.failed
        .map((item) => `<li><strong>${escapeHtml(item.filePath)}</strong><br>${escapeHtml(item.error)}</li>`)
        .join('')

    const warningItems = options.warnings
        .map((item) => `<li>${escapeHtml(item.filePath)} (${item.count} figyelmeztetés)</li>`)
        .join('')

    return `<!doctype html>
<html lang="hu">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Garmin ZIP újraprocesszálás</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 32px auto; padding: 0 16px; color: #0f172a; }
    h1 { margin-bottom: 8px; }
    .ok { color: #166534; }
    .warn { color: #92400e; }
    .err { color: #991b1b; }
    .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; margin: 12px 0; }
    ul { margin: 8px 0 0 18px; }
  </style>
</head>
<body>
  <h1>Garmin ZIP újraprocesszálás</h1>
  <p class="${options.failed.length === 0 ? 'ok' : 'warn'}">Kész. Feldolgozva: ${options.processed} / ${options.total}</p>
  <div class="card">
    <div><strong>Összes ZIP:</strong> ${options.total}</div>
    <div><strong>Sikeres:</strong> ${options.processed}</div>
    <div><strong>Hibás:</strong> ${options.failed.length}</div>
    <div><strong>Idő:</strong> ${options.elapsedMs} ms</div>
  </div>
  ${options.warnings.length > 0 ? `<div class="card"><h2 class="warn">Figyelmeztetések</h2><ul>${warningItems}</ul></div>` : ''}
  ${options.failed.length > 0 ? `<div class="card"><h2 class="err">Hibák</h2><ul>${failedItems}</ul></div>` : '<p class="ok">Minden ZIP sikeresen újraprocesszálva.</p>'}
</body>
</html>`
}
