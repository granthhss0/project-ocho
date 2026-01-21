// server.js
const express = require('express');
const fetch = require('node-fetch');
const Rewriter = require('./public/rewriter'); // You'll need to export this
const app = express();

app.get('/main', async (req, res) => {
    const targetUrl = req.query.url;
    const proxyPrefix = '/main?url='; // How the proxy identifies itself

    try {
        const response = await fetch(targetUrl);
        let contentType = response.headers.get('content-type');
        let body = await response.text();

        // ONLY rewrite if it's HTML. Don't rewrite images/binary files.
        if (contentType && contentType.includes('text/html')) {
            body = Rewriter.html(body, proxyPrefix);
        }

        res.set('Content-Type', contentType);
        res.send(body);
    } catch (e) {
        res.status(500).send("Proxy Error");
    }
});

app.listen(8080);
