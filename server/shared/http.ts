import type { IncomingMessage, ServerResponse } from 'node:http'

export function setCorsHeaders(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Activity-Id')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    if (chunks.length === 0) return {}
    const raw = Buffer.concat(chunks).toString('utf-8')
    return JSON.parse(raw) as Record<string, unknown>
}

export function handleOptions(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method !== 'OPTIONS') return false
    setCorsHeaders(res)
    res.statusCode = 204
    res.end()
    return true
}
