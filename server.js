const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const Rewriter = require('./public/rewriter');
const app = express();

// Serve the 'public' folder (sw.js, inject.js, index.html)
app.use(express.static(path.join(__dirname, 'public')));

app.get('/main', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No URL provided");

    // Auto-fix protocol
    if (!/^https?:\/\//i.test(targetUrl)) {
        targetUrl = 'https://' + targetUrl;
    }

    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            redirect: 'follow'
        });

        // Strip security headers that stop sites from running on a different domain
        const headersToStrip = [
            'content-security-policy',
            'content-security-policy-report-only',
            'x-frame-options',
            'x-content-type-options',
            'cross-origin-opener-policy'
        ];
        
        const responseHeaders = response.headers.raw();
        Object.keys(responseHeaders).forEach(key => {
            if (!headersToStrip.includes(key.toLowerCase())) {
                res.setHeader(key, responseHeaders[key]);
            }
        });

        const contentType = response.headers.get('content-type') || '';
        
        // Only rewrite HTML; pipe everything else (JS, CSS, Images, JSON) directly
        if (contentType.includes('text/html')) {
            let body = await response.text();
            const origin = new URL(targetUrl).origin;
            body = Rewriter.html(body, origin);
            return res.send(body);
        }

        response.body.pipe(res);

    } catch (err) {
        console.error("Relay Error:", err.message);
        res.status(500).send("Proxy Error: " + err.message);
    }
});

// The Catch-All: Fixes "leaked" requests (e.g., /api/data) by using the Referer
app.get('*', async (req, res) => {
    const referer = req.headers.referer;

    if (referer && referer.includes('/main?url=')) {
        try {
            const refUrl = new URL(referer);
            const rawTarget = refUrl.searchParams.get('url');
            if (rawTarget) {
                const targetOrigin = new URL(rawTarget).origin;
                const actualTarget = targetOrigin + req.url;
                return res.redirect(`/main?url=${encodeURIComponent(actualTarget)}`);
            }
        } catch (e) { /* ignore parse errors */ }
    }
    // Return an empty 404 so JSON parsers don't crash on "Project Ocho" text
    res.status(404).end();
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Project Ocho active on port ${PORT}`));
