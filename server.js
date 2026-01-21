const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const path = require('path');
const Rewriter = require('./public/rewriter');
const app = express();

// 1. SPEED FIX: Reuse connections so the site loads faster
const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 100,
    timeout: 60000
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/main', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No URL provided");

    // Auto-HTTPS logic
    if (!/^https?:\/\//i.test(targetUrl)) {
        targetUrl = 'https://' + targetUrl;
    }

    try {
        const response = await fetch(targetUrl, {
            agent: proxyAgent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Encoding': 'identity', // Prevents double-compression glitches
                'Access-Control-Allow-Origin': '*'
            },
            redirect: 'follow'
        });

        // 2. STYLING FIX: Strip security headers that block CSS/Fonts
        const blockedHeaders = [
            'content-security-policy', 
            'content-security-policy-report-only',
            'x-frame-options',
            'x-content-type-options',
            'cross-origin-opener-policy',
            'content-length',
            'strict-transport-security'
        ];

        response.headers.forEach((value, name) => {
            if (!blockedHeaders.includes(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });

        // Ensure CORS is allowed for all proxied assets
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('text/html')) {
            let body = await response.text();
            const origin = new URL(targetUrl).origin;

            // 3. INTEGRITY FIX: Remove 'integrity' hashes that break modified CSS/JS
            body = body.replace(/integrity="sha[^"]*"/gi, '');
            
            // Apply URL rewriting
            body = Rewriter.html(body, origin);
            return res.send(body);
        }

        // Pipe images, scripts, and fonts directly
        response.body.pipe(res);

    } catch (err) {
        console.error("Proxy Error:", err);
        res.status(500).send("Proxy Error: " + err.message);
    }
});

// 4. LEAK FIX: Catch requests that TikTok/GitHub try to send to your domain directly
app.get('*', async (req, res) => {
    const referer = req.headers.referer;
    if (referer && referer.includes('/main?url=')) {
        try {
            const refUrl = new URL(referer);
            const targetUrlParam = refUrl.searchParams.get('url');
            if (targetUrlParam) {
                const targetOrigin = new URL(targetUrlParam).origin;
                const actualTarget = targetOrigin + req.url;
                return res.redirect(`/main?url=${encodeURIComponent(actualTarget)}`);
            }
        } catch (e) {}
    }
    
    // Serve local files if they exist, otherwise silent 404
    const localPath = path.join(__dirname, 'public', req.path);
    res.sendFile(localPath, (err) => {
        if (err) res.status(404).end();
    });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Project Ocho high-performance proxy live on ${PORT}`));
