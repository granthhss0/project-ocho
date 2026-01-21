const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const path = require('path');
const Rewriter = require('./public/rewriter');
const app = express();

const proxyAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/main', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No URL");

    try {
        const response = await fetch(targetUrl, {
            agent: proxyAgent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Encoding': 'identity'
            }
        });

        const contentType = response.headers.get('content-type') || '';
        
        // Forward essential headers
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (contentType.includes('text/html')) {
            let body = await response.text();
            const origin = new URL(targetUrl).origin;
            // Strip integrity hashes and rewrite URLs
            body = body.replace(/integrity="sha[^"]*"/gi, '');
            body = Rewriter.html(body, origin);
            return res.send(body);
        }

        // For JS/CSS, just pipe directly to preserve original encoding
        response.body.pipe(res);

    } catch (err) {
        res.status(500).end();
    }
});

// THE MOST IMPORTANT PART: Smart Catch-All
app.get('*', (req, res) => {
    const referer = req.headers.referer;
    
    if (referer && referer.includes('/main?url=')) {
        try {
            const urlObj = new URL(referer);
            const targetParam = urlObj.searchParams.get('url');
            const targetOrigin = new URL(targetParam).origin;
            
            // Redirect leaked assets back into the proxy
            return res.redirect(`/main?url=${encodeURIComponent(targetOrigin + req.url)}`);
        } catch (e) {}
    }

    // NEVER send HTML for a failed script/API call. 
    // Send an empty 404 to prevent the "Unexpected token '<'" error.
    res.status(404).set('Content-Type', 'text/plain').end();
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Proxy active on ${PORT}`));
