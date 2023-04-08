const http = require('http');
const https = require('https');
const tls_client = require('tls-client');
const { URL } = require('url');
const express = require('express');
const cookieParser = require('cookie-parser');

const options = {
    timeout: 3600000, // in milliseconds
    profile: tls_client.Chrome_110,
    followRedirects: false,
};

const jar = new tls_client.CookieJar();

const client = tls_client.createHttpClient({
    logger: tls_client.createNoopLogger(),
    options: options,
    cookieJar: jar,
});

const access_token = process.env.ACCESS_TOKEN;
const puid = process.env.PUID;
const http_proxy = process.env.http_proxy;

if (!access_token && !puid) {
    console.error("Error: ACCESS_TOKEN and PUID are not set");
    process.exit(1);
}

if (http_proxy) {
    const proxyUrl = new URL(http_proxy);
    const agent = proxyUrl.protocol === 'https:'
        ? new https.Agent({
            host: proxyUrl.hostname,
            port: proxyUrl.port,
            rejectUnauthorized: false,
        })
        : new http.Agent({
            host: proxyUrl.hostname,
            port: proxyUrl.port,
        });
    options.agent = agent;
    console.log(`Proxy set: ${http_proxy}`);
}

if (access_token) {
    const refreshPuid = async () => {
        const url = "https://chat.openai.com/backend-api/models";
        const headers = {
            "Host": "chat.openai.com",
            "origin": "https://chat.openai.com/chat",
            "referer": "https://chat.openai.com/chat",
            "sec-ch-ua": `Chromium";v="110", "Not A(Brand";v="24", "Brave";v="110`,
            "sec-ch-ua-platform": "Linux",
            "content-type": "application/json",
            "accept": "text/event-stream",
            "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
            "Authorization": `Bearer ${access_token}`,
        };
        const cookie = jar.getCookie('_puid', url);

        if (cookie) {
            headers.cookie = cookie.toString();
        } else {
            headers.cookie = `_puid=${puid}`;
        }

        while (true) {
            try {
                const res = await client.get(url, { headers: headers });
                console.log(`Got response: ${res.statusCode}`);
                if (res.statusCode !== 200) {
                    console.error(`Error: ${res.statusCode}`);
                    const body = await readStream(res);
                    console.error(body);
                    return;
                }
                const puidCookie = res.headers['set-cookie'].find(c => c.startsWith('_puid='));
                if (puidCookie) {
                    const value = puidCookie.split(';')[0];
                    console.log(`puid: ${value}`);
                    jar.setCookie(value, url);
                }
            } catch (err) {
                console.error("Error: Failed to refresh puid cookie");
                console.error(err);
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 6 * 3600000)); // 6 hours
        }
    };
    refreshPuid().catch(console.error);
}

const app = express();
const port = process.env.PORT || 8080;

app.use(cookieParser());

app.get('/ping', (req, res) => {
    res.json({ message: 'pong' });

app.all('/api/*path', proxy);

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});

function proxy(req, res) {
    const url = `https://chat.openai.com/backend-api${req.params.path}`;
    const headers = {
        "Host": "chat.openai.com",
        "Origin": "https://chat.openai.com/chat",
        "Connection": "keep-alive",
        "Content-Type": "application/json",
        "Keep-Alive": "timeout=360",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36",
        "Authorization": req.headers.authorization,
    };
    const puidCookie = req.cookies._puid;
    if (!puidCookie) {
        headers.cookie = `_puid=${puid}`;
    } else {
        headers.cookie = `_puid=${puidCookie}`;
    }
    const options = {
        method: req.method,
        headers: headers,
    };
    const body = req.method === 'GET' ? undefined : req.body;
    const clientReq = client.request(url, options, (clientRes) => {
        res.set('Content-Type', clientRes.headers['content-type']);
        res.status(clientRes.statusCode);
        clientRes.pipe(res);
    });
    if (body) {
        clientReq.write(JSON.stringify(body));
    }
    clientReq.end();
}

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

async function readStream(stream) {
    let data = '';
    for await (const chunk of stream) {
        data += chunk;
    }
    return data;
}
