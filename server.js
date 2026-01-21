const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();

// 1. IMPORTANT: Serve static files from the 'public' directory
// This allows the browser to find index.html, sw.js, etc.
app.use(express.static(path.join(__dirname, 'public')));

// 2. The Relay Logic (from previous steps)
app.get('/main', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No URL provided");

    try {
        const response = await fetch(targetUrl);
        res.status(response.status);
        res.set('Content-Type', response.headers.get('content-type'));
        response.body.pipe(res);
    } catch (err) {
        res.status(500).send("Proxy Error");
    }
});

app.get('/main', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No URL provided");

    // 1. URL Normalization: Add https if missing
    if (!targetUrl.startsWith('http')) {
        targetUrl = 'https://' + targetUrl;
    }

    try {
        const response = await fetch(targetUrl, {
            headers: {
                // 2. Browser Spoofing: Essential for TikTok/Google
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            },
            redirect: 'follow', // Follow TikTok's redirects
            follow: 20
        });

        const contentType = response.headers.get('content-type');
        
        // If it's an image or video, just pipe it through
        if (!contentType || !contentType.includes('text/html')) {
            res.set('Content-Type', contentType);
            return response.body.pipe(res);
        }

        // 3. Rewrite HTML to fix relative links
        let body = await response.text();
        const origin = new URL(targetUrl).origin;
        body = Rewriter.html(body, origin); // We pass the 'origin' to fix paths

        res.set('Content-Type', 'text/html');
        res.send(body);

    } catch (err) {
        console.error(err);
        res.status(500).send(`Proxy Error: ${err.message}`);
    }
});

// 3. LISTEN on 0.0.0.0 (required for Fly.io) 
// and use the PORT environment variable they provide.
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Project Ocho is live on port ${PORT}`);
});
