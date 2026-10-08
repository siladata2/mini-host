import "dotenv/config";
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static("."));

const HEROKU_API = "https://api.heroku.com";
const deployments = new Map();

/* =========================
   BASIC HELPERS
========================= */

function herokuHeaders() {
    return {
        Authorization: `Bearer ${process.env.HEROKU_API_KEY}`,
        Accept: "application/vnd.heroku+json; version=3",
        "Content-Type": "application/json"
    };
}

async function herokuRequest(endpoint, options = {}) {
    const response = await fetch(`${HEROKU_API}${endpoint}`, {
        ...options,
        headers: {
            ...herokuHeaders(),
            ...(options.headers || {})
        }
    });

    const text = await response.text();

    let data;

    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { message: text };
    }

    if (!response.ok) {
        throw new Error(
            data.message ||
            data.error ||
            `Heroku API error ${response.status}`
        );
    }

    return data;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================
   GITHUB
========================= */

function parseGithubUrl(input) {
    try {
        const url = new URL(input.trim());

        if (url.hostname !== "github.com") {
            throw new Error("Tumia public GitHub repository URL.");
        }

        const parts = url.pathname
            .replace(/^\/|\/$/g, "")
            .split("/");

        if (parts.length < 2) {
            throw new Error("GitHub repository URL si sahihi.");
        }

        const owner = parts[0];
        const repo = parts[1].replace(/\.git$/, "");

        if (!owner || !repo) {
            throw new Error("GitHub repository URL si sahihi.");
        }

        return {
            owner,
            repo,
            url: `https://github.com/${owner}/${repo}`
        };
    } catch (error) {
        throw new Error(
            error.message || "GitHub repository URL si sahihi."
        );
    }
}

async function githubRequest(url) {
    const response = await fetch(url, {
        headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "mini-heroku"
        }
    });

    const text = await response.text();

    let data;

    try {
        data = JSON.parse(text);
    } catch {
        data = null;
    }

    if (!response.ok) {
        if (response.status === 404) {
            throw new Error(
                "Repository haipo au si public."
            );
        }

        throw new Error(
            data?.message ||
            `GitHub API error ${response.status}`
        );
    }

    return data;
}

async function getGithubRepository(owner, repo) {
    return await githubRequest(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    );
}

async function getGithubFile(owner, repo, branch, filename) {
    const url =
        `https://raw.githubusercontent.com/` +
        `${encodeURIComponent(owner)}/` +
        `${encodeURIComponent(repo)}/` +
        `${encodeURIComponent(branch)}/` +
        filename;

    const response = await fetch(url, {
        headers: {
            "User-Agent": "mini-heroku"
        }
    });

    if (!response.ok) {
        return null;
    }

    return await response.text();
}

/* =========================
   APP.JSON ENV PARSER
========================= */

function parseEnv(appJson) {
    const env = appJson?.env || {};

    return Object.entries(env).map(([key, definition]) => {
        if (
            definition &&
            typeof definition === "object" &&
            !Array.isArray(definition)
        ) {
            return {
                key,
                required: definition.required !== false,
                description:
                    definition.description ||
                    `Value for ${key}`,
                value:
                    definition.value ??
                    definition.default ??
                    ""
            };
        }

        return {
            key,
            required: false,
            description: `Value for ${key}`,
            value:
                definition === undefined ||
                definition === null
                    ? ""
                    : String(definition)
        };
    });
}

/* =========================
   APP ANALYSIS
========================= */

async function analyzeRepository(repoUrl) {
    const github = parseGithubUrl(repoUrl);

    const repository = await getGithubRepository(
        github.owner,
        github.repo
    );

    if (repository.private) {
        throw new Error(
            "Repository hii ni private. Mini Heroku inaruhusu public repositories tu."
        );
    }

    const branch = repository.default_branch || "main";

    const [
        appJsonText,
        packageJsonText,
        procfileText,
        requirementsText
    ] = await Promise.all([
        getGithubFile(
            github.owner,
            github.repo,
            branch,
            "app.json"
        ),
        getGithubFile(
            github.owner,
            github.repo,
            branch,
            "package.json"
        ),
        getGithubFile(
            github.owner,
            github.repo,
            branch,
            "Procfile"
        ),
        getGithubFile(
            github.owner,
            github.repo,
            branch,
            "requirements.txt"
        )
    ]);

    let appJson = {};

    if (appJsonText) {
        try {
            appJson = JSON.parse(appJsonText);
        } catch {
            throw new Error(
                "app.json ipo lakini JSON yake si sahihi."
            );
        }
    }

    let packageJson = {};

    if (packageJsonText) {
        try {
            packageJson = JSON.parse(packageJsonText);
        } catch {
            throw new Error(
                "package.json ipo lakini JSON yake si sahihi."
            );
        }
    }

    const env = parseEnv(appJson);

    let processes = {};

    if (procfileText) {
        for (const line of procfileText.split(/\r?\n/)) {
            const match = line.match(
                /^\s*([A-Za-z0-9_-]+)\s*:\s*(.+)$/
            );

            if (match) {
                processes[match[1]] = match[2].trim();
            }
        }
    }

    const formation = appJson.formation || {};

    let runtime = "unknown";

    if (packageJson.name) {
        runtime = "nodejs";
    } else if (requirementsText) {
        runtime = "python";
    }

    if (appJson.buildpacks?.length) {
        runtime = "custom";
    }

    const startCommand =
        processes.web ||
        processes.worker ||
        packageJson.scripts?.start ||
        null;

    return {
        success: true,

        repository: {
            name: repository.name,
            full_name: repository.full_name,
            description: repository.description || "",
            branch,
            url: github.url,
            html_url: repository.html_url
        },

        app: {
            name:
                appJson.name ||
                repository.name,

            description:
                appJson.description ||
                repository.description ||
                "",

            runtime,

            env,

            buildpacks:
                appJson.buildpacks || [],

            formation,

            processes,

            startCommand,

            hasAppJson: Boolean(appJsonText),
            hasPackageJson: Boolean(packageJsonText),
            hasProcfile: Boolean(procfileText)
        }
    };
}

/* =========================
   HEALTH
========================= */

app.get("/api/health", async (req, res) => {
    res.json({
        success: true,
        service: "mini-heroku",
        team: process.env.HEROKU_TEAM || null,
        configured: Boolean(process.env.HEROKU_API_KEY)
    });
});

/* =========================
   ANALYZE REPOSITORY
========================= */

app.post("/api/repository/analyze", async (req, res) => {
    try {
        const { repo } = req.body;

        if (!repo) {
            return res.status(400).json({
                success: false,
                error: "Weka GitHub repository URL."
            });
        }

        const result = await analyzeRepository(repo);

        res.json(result);

    } catch (error) {
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
});

/* =========================
   HEROKU APPS
========================= */

app.get("/api/apps", async (req, res) => {
    try {
        const team = process.env.HEROKU_TEAM;

        if (team) {
            const apps = await herokuRequest(
                `/teams/${encodeURIComponent(team)}/apps`
            );

            return res.json({
                success: true,
                apps
            });
        }

        const apps = await herokuRequest("/apps");

        res.json({
            success: true,
            apps
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/* =========================
   CREATE HEROKU TEAM APP
========================= */

async function createHerokuApp(name) {
    if (!process.env.HEROKU_TEAM) {
        throw new Error(
            "HEROKU_TEAM haijawekwa kwenye .env."
        );
    }

    return await herokuRequest(
        "/teams/apps",
        {
            method: "POST",
            body: JSON.stringify({
                name,
                team: process.env.HEROKU_TEAM,
                region: "us"
            })
        }
    );
}

/* =========================
   CONFIG VARS
========================= */

async function setConfigVars(appName, values) {
    if (!values || typeof values !== "object") {
        return {};
    }

    const clean = {};

    for (const [key, value] of Object.entries(values)) {
        if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
            continue;
        }

        if (
            value !== undefined &&
            value !== null &&
            String(value).trim() !== ""
        ) {
            clean[key] = String(value);
        }
    }

    if (!Object.keys(clean).length) {
        return {};
    }

    return await herokuRequest(
        `/apps/${encodeURIComponent(appName)}/config-vars`,
        {
            method: "PATCH",
            body: JSON.stringify(clean)
        }
    );
}

/* =========================
   BUILD SOURCE
========================= */

async function createSource() {
    return await herokuRequest(
        "/sources",
        {
            method: "POST",
            body: JSON.stringify({})
        }
    );
}

async function uploadSource(putUrl, sourceUrl) {
    const response = await fetch(sourceUrl);

    if (!response.ok) {
        throw new Error(
            `GitHub source download failed: ${response.status}`
        );
    }

    const buffer = Buffer.from(
        await response.arrayBuffer()
    );

    const upload = await fetch(putUrl, {
        method: "PUT",
        headers: {
            "Content-Type": "application/octet-stream"
        },
        body: buffer
    });

    if (!upload.ok) {
        const text = await upload.text();

        throw new Error(
            `Heroku source upload failed: ${text}`
        );
    }
}

/* =========================
   BUILD
========================= */

async function createBuild(
    appName,
    sourceGetUrl,
    version,
    buildpacks = []
) {
    const body = {
        source_blob: {
            url: sourceGetUrl,
            version
        }
    };

    if (Array.isArray(buildpacks) && buildpacks.length) {
        body.buildpacks = buildpacks.map(item => {
            if (typeof item === "string") {
                return {
                    url: item
                };
            }

            return item;
        });
    }

    return await herokuRequest(
        `/apps/${encodeURIComponent(appName)}/builds`,
        {
            method: "POST",
            body: JSON.stringify(body)
        }
    );
}

/* =========================
   FORMATION
========================= */

function buildFormation(appData) {
    const formation = appData.formation || {};
    const processes = appData.processes || {};

    const updates = [];

    for (const [type, config] of Object.entries(formation)) {
        if (!config || typeof config !== "object") {
            continue;
        }

        updates.push({
            type,
            quantity:
                Number.isInteger(config.quantity)
                    ? config.quantity
                    : 1,

            dyno_size: {
                name:
                    config.size ||
                    "eco"
            }
        });
    }

    if (!updates.length) {
        if (processes.worker) {
            updates.push({
                type: "worker",
                quantity: 1,
                dyno_size: {
                    name: "eco"
                }
            });
        } else if (processes.web) {
            updates.push({
                type: "web",
                quantity: 1,
                dyno_size: {
                    name: "eco"
                }
            });
        }
    }

    return updates;
}

async function applyFormation(appName, appData) {
    const updates = buildFormation(appData);

    if (!updates.length) {
        return null;
    }

    return await herokuRequest(
        `/apps/${encodeURIComponent(appName)}/formation`,
        {
            method: "PATCH",
            body: JSON.stringify({
                updates
            })
        }
    );
}

/* =========================
   BUILD LOG STREAM
========================= */

async function streamBuildLogs(job, outputUrl) {
    try {
        const response = await fetch(outputUrl);

        if (!response.ok || !response.body) {
            job.logs.push(
                "[Mini Heroku] Build log stream haikupatikana."
            );

            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { value, done } =
                await reader.read();

            if (done) break;

            const chunk =
                decoder.decode(value, {
                    stream: true
                });

            if (chunk) {
                job.logs.push(chunk);
                job.updatedAt = Date.now();

                for (const client of job.clients) {
                    client.write(
                        `data: ${JSON.stringify({
                            type: "log",
                            data: chunk
                        })}\n\n`
                    );
                }
            }
        }
    } catch (error) {
        job.logs.push(
            `[Mini Heroku] Log stream error: ${error.message}`
        );
    }
}

/* =========================
   DEPLOY JOB
========================= */

async function runDeployment(job, repoUrl, envValues) {
    try {
        job.status = "analyzing";

        job.logs.push(
            "[Mini Heroku] Analyzing repository..."
        );

        const analysis =
            await analyzeRepository(repoUrl);

        job.analysis = analysis;

        const required = analysis.app.env.filter(
            item =>
                item.required &&
                !item.value &&
                !envValues?.[item.key]
        );

        if (required.length) {
            throw new Error(
                `Environment variables missing: ${
                    required.map(x => x.key).join(", ")
                }`
            );
        }

        job.logs.push(
            `[Mini Heroku] Repository: ${analysis.repository.full_name}`
        );

        job.logs.push(
            `[Mini Heroku] Branch: ${analysis.repository.branch}`
        );

        job.status = "creating_app";

        const baseName =
            String(analysis.app.name)
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, "-")
                .replace(/-+/g, "-")
                .replace(/^-|-$/g, "")
                .slice(0, 25);

        const appName =
            `${baseName || "mini-app"}-${Math.random()
                .toString(36)
                .slice(2, 6)}`;

        job.appName = appName;

        job.logs.push(
            `[Mini Heroku] Creating Team app: ${appName}`
        );

        const herokuApp =
            await createHerokuApp(appName);

        job.logs.push(
            `[Mini Heroku] Heroku app created.`
        );

        const configVars = {};

        for (const item of analysis.app.env) {
            const supplied =
                envValues?.[item.key];

            if (
                supplied !== undefined &&
                supplied !== null &&
                String(supplied).trim() !== ""
            ) {
                configVars[item.key] =
                    String(supplied);
            } else if (item.value) {
                configVars[item.key] =
                    String(item.value);
            }
        }

        if (Object.keys(configVars).length) {
            job.logs.push(
                `[Mini Heroku] Setting ${Object.keys(configVars).length} config vars...`
            );

            await setConfigVars(
                appName,
                configVars
            );
        }

        job.status = "uploading";

        job.logs.push(
            "[Mini Heroku] Downloading public GitHub source..."
        );

        const source =
            await createSource();

        const githubArchive =
            `https://github.com/${encodeURIComponent(
                analysis.repository.full_name.split("/")[0]
            )}/${encodeURIComponent(
                analysis.repository.full_name.split("/")[1]
            )}/archive/refs/heads/${encodeURIComponent(
                analysis.repository.branch
            )}.tar.gz`;

        await uploadSource(
            source.source_blob.put_url,
            githubArchive
        );

        job.logs.push(
            "[Mini Heroku] Source uploaded to Heroku."
        );

        job.status = "building";

        const build =
            await createBuild(
                appName,
                source.source_blob.get_url,
                analysis.repository.branch,
                analysis.app.buildpacks
            );

        job.buildId = build.id;

        job.logs.push(
            `[Mini Heroku] Build started: ${build.id}`
        );

        if (build.output_stream_url) {
            job.logStreamPromise =
                streamBuildLogs(
                    job,
                    build.output_stream_url
                );
        }

        let finalBuild = build;

        while (
            finalBuild.status === "pending"
        ) {
            await sleep(3000);

            finalBuild =
                await herokuRequest(
                    `/apps/${encodeURIComponent(
                        appName
                    )}/builds/${encodeURIComponent(
                        build.id
                    )}`
                );
        }

        if (job.logStreamPromise) {
            await job.logStreamPromise;
        }

        if (finalBuild.status !== "succeeded") {
            throw new Error(
                "Heroku build failed."
            );
        }

        job.logs.push(
            "[Mini Heroku] Build succeeded."
        );

        job.status = "starting";

        const formation =
            await applyFormation(
                appName,
                analysis.app
            );

        if (formation) {
            job.logs.push(
                "[Mini Heroku] Dyno formation configured."
            );
        }

        job.status = "success";

        job.result = {
            app: herokuApp,
            appName,
            url:
                herokuApp.web_url ||
                `https://${appName}.herokuapp.com`,
            build: finalBuild
        };

        job.logs.push(
            `[Mini Heroku] DEPLOYMENT SUCCESS: ${appName}`
        );

    } catch (error) {
        job.status = "failed";
        job.error = error.message;

        job.logs.push(
            `[Mini Heroku] DEPLOYMENT FAILED: ${error.message}`
        );
    }

    for (const client of job.clients) {
        client.write(
            `data: ${JSON.stringify({
                type: "complete",
                status: job.status,
                error: job.error || null,
                result: job.result || null
            })}\n\n`
        );

        client.end();
    }

    job.clients.clear();
}

/* =========================
   START DEPLOYMENT
========================= */

app.post("/api/deploy", async (req, res) => {
    try {
        const { repo, env } = req.body;

        if (!repo) {
            return res.status(400).json({
                success: false,
                error: "Weka GitHub repository URL."
            });
        }

        if (!process.env.HEROKU_API_KEY) {
            return res.status(500).json({
                success: false,
                error:
                    "HEROKU_API_KEY haijawekwa."
            });
        }

        if (!process.env.HEROKU_TEAM) {
            return res.status(500).json({
                success: false,
                error:
                    "HEROKU_TEAM haijawekwa."
            });
        }

        const deploymentId =
            `${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 9)}`;

        const job = {
            id: deploymentId,
            status: "queued",
            logs: [],
            clients: new Set(),
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        deployments.set(
            deploymentId,
            job
        );

        runDeployment(
            job,
            repo,
            env || {}
        );

        res.json({
            success: true,
            deploymentId
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/* =========================
   DEPLOYMENT STATUS
========================= */

app.get(
    "/api/deploy/:id",
    (req, res) => {
        const job =
            deployments.get(req.params.id);

        if (!job) {
            return res.status(404).json({
                success: false,
                error: "Deployment haipatikani."
            });
        }

        res.json({
            success: true,
            id: job.id,
            status: job.status,
            appName: job.appName || null,
            error: job.error || null,
            result: job.result || null,
            logs: job.logs
        });
    }
);

/* =========================
   LIVE LOGS SSE
========================= */

app.get(
    "/api/deploy/:id/logs",
    (req, res) => {
        const job =
            deployments.get(req.params.id);

        if (!job) {
            return res.status(404).end();
        }

        res.setHeader(
            "Content-Type",
            "text/event-stream"
        );

        res.setHeader(
            "Cache-Control",
            "no-cache"
        );

        res.setHeader(
            "Connection",
            "keep-alive"
        );

        res.flushHeaders();

        for (const log of job.logs) {
            res.write(
                `data: ${JSON.stringify({
                    type: "log",
                    data: log
                })}\n\n`
            );
        }

        if (
            job.status === "success" ||
            job.status === "failed"
        ) {
            res.write(
                `data: ${JSON.stringify({
                    type: "complete",
                    status: job.status,
                    error: job.error || null,
                    result: job.result || null
                })}\n\n`
            );

            return res.end();
        }

        job.clients.add(res);

        req.on("close", () => {
            job.clients.delete(res);
        });
    }
);

/* =========================
   RESTART APP
========================= */

app.post(
    "/api/apps/:name/restart",
    async (req, res) => {
        try {
            await herokuRequest(
                `/apps/${encodeURIComponent(
                    req.params.name
                )}/dynos`,
                {
                    method: "DELETE"
                }
            );

            res.json({
                success: true
            });

        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
);

/* =========================
   DELETE APP
========================= */

app.delete(
    "/api/apps/:name",
    async (req, res) => {
        try {
            await herokuRequest(
                `/apps/${encodeURIComponent(
                    req.params.name
                )}`,
                {
                    method: "DELETE"
                }
            );

            res.json({
                success: true
            });

        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
);

/* =========================
   CLEAN OLD JOBS
========================= */

setInterval(() => {
    const now = Date.now();

    for (const [id, job] of deployments) {
        if (
            now - job.createdAt >
            60 * 60 * 1000
        ) {
            deployments.delete(id);
        }
    }
}, 10 * 60 * 1000);

/* =========================
   START
========================= */

app.listen(PORT, () => {
    console.log(
        `Mini Heroku running on port ${PORT}`
    );
});