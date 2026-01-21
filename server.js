// server.js
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const Rewriter = require('./public/rewriter');
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/main', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No URL provided");

    // --- AUTOMATIC HTTPS LOGIC ---
    if (!/^https?:\/\//i.test(targetUrl)) {
        targetUrl = 'https://' + targetUrl;
    }

    try {
        const response = await fetch(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/115.0.0.0 Safari/537.36' },
            redirect: 'follow'
        });

        // --- STRIP SECURITY HEADERS ---
        // This stops the "404" and "Refused to load" errors
        res.removeHeader('Content-Security-Policy');
        res.removeHeader('X-Frame-Options');
        
        const contentType = response.headers.get('content-type');
        res.set('Content-Type', contentType);

        if (contentType && contentType.includes('text/html')) {
            let body = await response.text();
            const origin = new URL(targetUrl).origin;
            body = Rewriter.html(body, origin);
            return res.send(body);
        }

        response.body.pipe(res);
    } catch (err) {
        res.status(500).send("Proxy Error: " + err.message);
    }
});

// server.js update
app.get('*', async (req, res) => {
    // If it's a static file we actually have, serve it
    const localPath = path.join(__dirname, 'public', req.path);
    if (require('fs').existsSync(localPath)) {
        return res.sendFile(localPath);
    }

    // --- LEAK PROTECTION ---
    // If we don't have the file, check if the request came from a proxied page
    const referer = req.headers.referer;
    if (referer && referer.includes('/main?url=')) {
        const refUrl = new URL(referer);
        const targetOrigin = new URL(decodeURIComponent(refUrl.searchParams.get('url'))).origin;
        const actualTarget = targetOrigin + req.url;
        
        console.log(`Redirecting leaked request: ${actualTarget}`);
        return res.redirect(`/main?url=${encodeURIComponent(actualTarget)}`);
    }

    res.status(404).send("Project Ocho: Resource Not Found");
});

// --- THE 404 FIX ---
// If the app requests a path we don't recognize, it's likely a relative asset 
// (like /scripts/main.js). We don't want to throw a 404.
app.get('*', (req, res) => {
    res.status(404).send("Project Ocho: Use the search bar to load a site first.");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Ocho live on ${PORT}`));
