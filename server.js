const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const Rewriter = require('./public/rewriter');
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/main', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No URL provided");

    if (!/^https?:\/\//i.test(targetUrl)) {
        targetUrl = 'https://' + targetUrl;
    }

    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Encoding': 'identity' // <--- CRITICAL: Asks the target server NOT to compress
            },
            redirect: 'follow'
        });

        // Copy headers but EXCLUDE security and compression headers
        const forbiddenHeaders = [
            'content-security-policy',
            'content-security-policy-report-only',
            'x-frame-options',
            'content-encoding', // Let Express handle encoding
            'content-length',   // Length changes after rewriting
            'transfer-encoding'
        ];

        response.headers.forEach((value, name) => {
            if (!forbiddenHeaders.includes(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });

        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('text/html')) {
            let body = await response.text();
            const origin = new URL(targetUrl).origin;
            body = Rewriter.html(body, origin);
            return res.send(body);
        }

        // For images/videos/scripts, pipe the raw stream
        response.body.pipe(res);

    } catch (err) {
        res.status(500).send("Relay Error: " + err.message);
    }
});

// Catch-all for leaked assets
app.get('*', (req, res) => {
    const referer = req.headers.referer;
    if (referer && referer.includes('/main?url=')) {
        try {
            const refUrl = new URL(referer);
            const targetOrigin = new URL(refUrl.searchParams.get('url')).origin;
            return res.redirect(`/main?url=${encodeURIComponent(targetOrigin + req.url)}`);
        } catch (e) {}
    }
    res.status(404).end();
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Ocho live on ${PORT}`));
