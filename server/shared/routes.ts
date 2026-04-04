import type { ViteDevServer } from 'vite'
import { buildResultsPdf, collectResultTextEntries } from './resultsPdf'
import { handleOptions, setCorsHeaders } from './http'

export interface RegisterSharedRoutesOptions {
    archiveDir: string
}

export function registerSharedRoutes(server: ViteDevServer, options: RegisterSharedRoutesOptions): void {
    const { archiveDir } = options

    server.middlewares.use('/api/download_results_pdf', async (req, res) => {
        if (handleOptions(req, res)) return
        setCorsHeaders(res)

        if (req.method !== 'GET') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
        }

        try {
            const entries = await collectResultTextEntries(archiveDir)
            const pdfBuffer = await buildResultsPdf(entries)
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)

            res.statusCode = 200
            res.setHeader('Content-Type', 'application/pdf')
            res.setHeader('Content-Disposition', `attachment; filename="download-results-${stamp}.pdf"`)
            res.end(pdfBuffer)
        } catch (err) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            }))
        }
    })
}
