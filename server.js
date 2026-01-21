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

// 3. LISTEN on 0.0.0.0 (required for Fly.io) 
// and use the PORT environment variable they provide.
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Project Ocho is live on port ${PORT}`);
});
