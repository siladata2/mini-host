import "dotenv/config";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";

const execFileAsync = promisify(execFile);
const app = express();

const PORT = process.env.PORT || 3000;
const HEROKU_API = "https://api.heroku.com";

app.use(express.json({ limit: "2mb" }));
app.use(express.static("."));

const deployments = new Map();

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomId() {
    return `${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
}

function herokuHeaders(extra = {}) {
    return {
        Authorization: `Bearer ${process.env.HEROKU_API_KEY}`,
        Accept: "application/vnd.heroku+json; version=3",
        "Content-Type": "application/json",
        ...extra
    };
}

async function herokuRequest(endpoint, options = {}) {
    if (!process.env.HEROKU_API_KEY) {
        throw new Error("HEROKU_API_KEY haijawekwa kwenye Heroku Config Vars.");
    }

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
        const detail =
            data.message ||
            data.error ||
            (typeof data === "string" ? data : "");

        throw new Error(`Heroku API (${response.status}): ${detail || "Request failed"}`);
    }

    return data;
}

function getRepoInput(body = {}) {
    const value =
        body.repo ??
        body.repositoryUrl ??
        body.repository ??
        body.url ??
        "";

    return String(value).trim();
}

function getRepoName(input) {
    const parsed = parseGithubUrl(input);
    return parsed.repo;
}

/* =========================================================
   GITHUB
========================================================= */

function parseGithubUrl(input) {
    let value = String(input || "").trim();

    if (/^(www\.)?github\.com\//i.test(value)) {
        value = `https://${value}`;
    }

    let url;

    try {
        url = new URL(value);
    } catch {
        throw new Error("GitHub repository URL si sahihi.");
    }

    if (
        url.protocol !== "https:" ||
        !["github.com", "www.github.com"].includes(url.hostname.toLowerCase())
    ) {
        throw new Error(
            "Tumia URL kama https://github.com/owner/repository"
        );
    }

    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length < 2) {
        throw new Error(
            "GitHub repository URL lazima iwe na owner na repository."
        );
    }

    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");

    if (
        !/^[A-Za-z0-9-]+$/.test(owner) ||
        !/^[A-Za-z0-9_.-]+$/.test(repo)
    ) {
        throw new Error("Owner au jina la GitHub repository si sahihi.");
    }

    return {
        owner,
        repo,
        url: `https://github.com/${owner}/${repo}`
    };
}

async function githubRequest(url) {
    const response = await fetch(url, {
        headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "mini-heroku"
        },
        signal: AbortSignal.timeout(30000)
    });

    const text = await response.text();
    let data = {};

    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = {};
    }

    if (!response.ok) {
        if (response.status === 404) {
            throw new Error("Repository haipo, si public, au URL si sahihi.");
        }

        throw new Error(
            data.message || `GitHub API error: ${response.status}`
        );
    }

    return data;
}

async function getGithubRepository(owner, repo) {
    return githubRequest(
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
        headers: { "User-Agent": "mini-heroku" },
        signal: AbortSignal.timeout(20000)
    });

    if (!response.ok) return null;

    return response.text();
}

/* =========================================================
   APP.JSON
========================================================= */

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
                description: definition.description || `Value for ${key}`,
                value: definition.value ?? definition.default ?? ""
            };
        }

        return {
            key,
            required: false,
            description: `Value for ${key}`,
            value: definition == null ? "" : String(definition)
        };
    });
}

/* =========================================================
   REPOSITORY ANALYSIS
========================================================= */

async function analyzeRepository(repoUrl) {
    const github = parseGithubUrl(repoUrl);

    const repository = await getGithubRepository(
        github.owner,
        github.repo
    );

    if (repository.private) {
        throw new Error(
            "Repository hii ni private. Kwa sasa Mini Heroku inahitaji public repository."
        );
    }

    const branch = repository.default_branch || "main";

    const [
        appJsonText,
        packageJsonText,
        procfileText,
        requirementsText
    ] = await Promise.all([
        getGithubFile(github.owner, github.repo, branch, "app.json"),
        getGithubFile(github.owner, github.repo, branch, "package.json"),
        getGithubFile(github.owner, github.repo, branch, "Procfile"),
        getGithubFile(github.owner, github.repo, branch, "requirements.txt")
    ]);

    let appJson = {};
    let packageJson = {};

    if (appJsonText) {
        try {
            appJson = JSON.parse(appJsonText);
        } catch {
            throw new Error("app.json ipo lakini JSON yake si sahihi.");
        }
    }

    if (packageJsonText) {
        try {
            packageJson = JSON.parse(packageJsonText);
        } catch {
            throw new Error("package.json ipo lakini JSON yake si sahihi.");
        }
    }

    const processes = {};

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

    let runtime = "unknown";

    if (packageJson.name || packageJson.scripts) {
        runtime = "nodejs";
    } else if (requirementsText) {
        runtime = "python";
    }

    if (Array.isArray(appJson.buildpacks) && appJson.buildpacks.length) {
        runtime = "custom";
    }

    const startCommand =
        processes.worker ||
        processes.web ||
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
            html_url: repository.html_url,
            private: repository.private
        },
        app: {
            name: appJson.name || repository.name,
            description: appJson.description || repository.description || "",
            runtime,
            env: parseEnv(appJson),
            buildpacks: appJson.buildpacks || [],
            formation: appJson.formation || {},
            processes,
            startCommand,
            hasAppJson: Boolean(appJsonText),
            hasPackageJson: Boolean(packageJsonText),
            hasProcfile: Boolean(procfileText)
        }
    };
}

/* =========================================================
   TEMP SOURCE
========================================================= */

async function prepareGithubSource(owner, repo, branch) {
    const tempDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "mini-heroku-")
    );

    const archivePath = path.join(tempDir, "github.tar.gz");
    const outputPath = path.join(tempDir, "source.tar.gz");
    const extractDir = path.join(tempDir, "extract");

    try {
        const archiveUrl =
            `https://api.github.com/repos/` +
            `${encodeURIComponent(owner)}/` +
            `${encodeURIComponent(repo)}/tarball/` +
            `${encodeURIComponent(branch)}`;

        const response = await fetch(archiveUrl, {
            headers: {
                "User-Agent": "mini-heroku",
                Accept: "application/vnd.github+json"
            },
            redirect: "follow",
            signal: AbortSignal.timeout(120000)
        });

        if (!response.ok) {
            throw new Error(`GitHub source download failed: ${response.status}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());

        if (!buffer.length) {
            throw new Error("GitHub repository archive iko empty.");
        }

        await fs.promises.writeFile(archivePath, buffer);

        await fs.promises.mkdir(extractDir, { recursive: true });

        await execFileAsync("tar", [
            "-xzf",
            archivePath,
            "-C",
            extractDir
        ]);

        const entries = await fs.promises.readdir(
            extractDir,
            { withFileTypes: true }
        );

        if (!entries.length) {
            throw new Error("Hakuna files zilizopatikana kwenye repository.");
        }

        let rootDir = extractDir;

        if (entries.length === 1 && entries[0].isDirectory()) {
            rootDir = path.join(extractDir, entries[0].name);
        }

        await execFileAsync("tar", [
            "-czf",
            outputPath,
            "-C",
            rootDir,
            "."
        ]);

        return {
            file: outputPath,
            cleanup: async () => {
                await fs.promises.rm(tempDir, {
                    recursive: true,
                    force: true
                });
            }
        };
    } catch (error) {
        await fs.promises.rm(tempDir, {
            recursive: true,
            force: true
        });
        throw error;
    }
}

/* =========================================================
   HEROKU APP CREATION
========================================================= */

async function createHerokuApp(name) {
    const team = process.env.HEROKU_TEAM;

    if (!team) {
        throw new Error("HEROKU_TEAM haijawekwa kwenye Config Vars.");
    }

    return herokuRequest("/teams/apps", {
        method: "POST",
        body: JSON.stringify({
            name,
            team,
            region: "us"
        })
    });
}

async function setConfigVars(appName, values) {
    if (!values || typeof values !== "object") return {};

    const clean = {};

    for (const [key, value] of Object.entries(values)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

        if (value !== undefined && value !== null && String(value).trim() !== "") {
            clean[key] = String(value);
        }
    }

    if (!Object.keys(clean).length) return {};

    return herokuRequest(
        `/apps/${encodeURIComponent(appName)}/config-vars`,
        {
            method: "PATCH",
            body: JSON.stringify(clean)
        }
    );
}

/* =========================================================
   SOURCE UPLOAD
========================================================= */

async function createSource() {
    return herokuRequest("/sources", {
        method: "POST",
        body: JSON.stringify({})
    });
}

async function uploadSource(putUrl, filePath) {
    const fileBuffer = await fs.promises.readFile(filePath);

    // Keep the signed upload URL free from additional headers.
    const response = await fetch(putUrl, {
        method: "PUT",
        body: fileBuffer,
        signal: AbortSignal.timeout(120000)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Heroku source upload failed: ${text}`);
    }

    return true;
}

/* =========================================================
   BUILDPACKS
========================================================= */

function normalizeBuildpacks(buildpacks, runtime) {
    if (Array.isArray(buildpacks) && buildpacks.length) {
        return buildpacks.map(item => {
            let url = typeof item === "string" ? item : item?.url;

            if (!url) return null;

            // Convert known aliases into canonical buildpack URLs.
            if (url === "heroku/nodejs") {
                url = "https://buildpack-registry.s3.amazonaws.com/buildpacks/heroku/nodejs.tgz";
            } else if (url === "heroku/python") {
                url = "https://buildpack-registry.s3.amazonaws.com/buildpacks/heroku/python.tgz";
            }

            return { url };
        }).filter(Boolean);
    }

    if (runtime === "nodejs") {
        return [{
            url: "https://buildpack-registry.s3.amazonaws.com/buildpacks/heroku/nodejs.tgz"
        }];
    }

    if (runtime === "python") {
        return [{
            url: "https://buildpack-registry.s3.amazonaws.com/buildpacks/heroku/python.tgz"
        }];
    }

    return [];
}

async function createBuild(appName, sourceGetUrl, version, buildpacks) {
    const body = {
        source_blob: {
            url: sourceGetUrl,
            version
        }
    };

    if (Array.isArray(buildpacks) && buildpacks.length) {
        body.buildpacks = buildpacks;
    }

    return herokuRequest(
        `/apps/${encodeURIComponent(appName)}/builds`,
        {
            method: "POST",
            body: JSON.stringify(body)
        }
    );
}

/* =========================================================
   JOB LOGS
========================================================= */

function addJobLog(job, message) {
    const lines = String(message).split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
        job.logs.push(line);
    }

    job.updatedAt = Date.now();

    for (const client of job.clients) {
        try {
            client.write(`data: ${JSON.stringify({
                type: "log",
                message: String(message),
                data: String(message)
            })}\n\n`);
        } catch {
            job.clients.delete(client);
        }
    }
}

async function streamBuildLogs(job, outputUrl) {
    try {
        const response = await fetch(outputUrl, {
            signal: AbortSignal.timeout(180000)
        });

        if (!response.ok || !response.body) {
            addJobLog(job, "[Mini Heroku] Build log stream haikupatikana.");
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { value, done } = await reader.read();

            if (done) break;

            const chunk = decoder.decode(value, { stream: true });

            if (chunk) addJobLog(job, chunk);
        }
    } catch (error) {
        addJobLog(job, `[Mini Heroku] Log stream: ${error.message}`);
    }
}

/* =========================================================
   FORMATION
========================================================= */

function buildFormation(appData) {
    const formation = appData.formation || {};
    const processes = appData.processes || {};
    const updates = [];

    for (const [type, config] of Object.entries(formation)) {
        if (!config || typeof config !== "object") continue;

        updates.push({
            type,
            quantity: Number.isInteger(config.quantity) ? config.quantity : 1,
            size: config.size || "basic"
        });
    }

    if (!updates.length) {
        if (processes.worker) {
            updates.push({
                type: "worker",
                quantity: 1,
                size: "basic"
            });
        } else if (processes.web) {
            updates.push({
                type: "web",
                quantity: 1,
                size: "basic"
            });
        }
    }

    return updates;
}

async function applyFormation(appName, appData) {
    const updates = buildFormation(appData);

    if (!updates.length) return null;

    return herokuRequest(
        `/apps/${encodeURIComponent(appName)}/formation`,
        {
            method: "PATCH",
            body: JSON.stringify({ updates })
        }
    );
}

async function deleteHerokuApp(appName) {
    if (!appName) return;

    return herokuRequest(
        `/apps/${encodeURIComponent(appName)}`,
        { method: "DELETE" }
    );
}

/* =========================================================
   DEPLOYMENT WORKER
========================================================= */

async function runDeployment(job, repoUrl, envValues = {}, requestedAppName = "") {
    let sourceCleanup = null;

    try {
        job.status = "analyzing";
        addJobLog(job, "[Mini Heroku] Analyzing repository...");

        const analysis = await analyzeRepository(repoUrl);
        job.analysis = analysis;

        addJobLog(job, `[Mini Heroku] Repository: ${analysis.repository.full_name}`);
        addJobLog(job, `[Mini Heroku] Branch: ${analysis.repository.branch}`);

        const missing = analysis.app.env.filter(item => {
            if (!item.required) return false;

            const submitted = envValues?.[item.key];
            const defaultValue = item.value;

            return (
                !String(submitted ?? "").trim() &&
                !String(defaultValue ?? "").trim()
            );
        });

        if (missing.length) {
            throw new Error(
                `Environment variables missing: ${missing.map(item => item.key).join(", ")}`
            );
        }

        const rawName = requestedAppName || analysis.app.name || analysis.repository.name;

        let baseName = String(rawName)
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 24);

        if (!baseName) baseName = "mini-app";

        // Always use a unique name to reduce app-name collisions.
        const appName = `${baseName}-${crypto.randomBytes(3).toString("hex")}`;
        job.appName = appName;

        job.status = "creating_app";
        addJobLog(job, `[Mini Heroku] Creating Heroku Team app: ${appName}`);

        const herokuApp = await createHerokuApp(appName);
        addJobLog(job, "[Mini Heroku] Heroku Team app created.");

        const configVars = {};

        for (const item of analysis.app.env) {
            const submitted = envValues?.[item.key];

            if (submitted !== undefined && submitted !== null && String(submitted).trim()) {
                configVars[item.key] = String(submitted);
            } else if (item.value !== undefined && item.value !== null && String(item.value).trim()) {
                configVars[item.key] = String(item.value);
            }
        }

        // Also accept extra environment variables entered in the dashboard.
        for (const [key, value] of Object.entries(envValues || {})) {
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
                value !== undefined &&
                value !== null &&
                String(value).trim() !== "") {
                configVars[key] = String(value);
            }
        }

        if (Object.keys(configVars).length) {
            addJobLog(job, "[Mini Heroku] Setting config vars...");
            await setConfigVars(appName, configVars);
        }

        job.status = "preparing_source";
        addJobLog(job, "[Mini Heroku] Downloading GitHub source...");

        const github = parseGithubUrl(repoUrl);
        const sourcePackage = await prepareGithubSource(
            github.owner,
            github.repo,
            analysis.repository.branch
        );

        sourceCleanup = sourcePackage.cleanup;
        addJobLog(job, "[Mini Heroku] Source archive prepared.");

        job.status = "uploading";

        const source = await createSource();
        addJobLog(job, "[Mini Heroku] Uploading source to Heroku...");

        await uploadSource(source.source_blob.put_url, sourcePackage.file);
        addJobLog(job, "[Mini Heroku] Source uploaded.");

        job.status = "building";

        const buildpacks = normalizeBuildpacks(
            analysis.app.buildpacks,
            analysis.app.runtime
        );

        addJobLog(job, "[Mini Heroku] Starting Heroku build...");

        const build = await createBuild(
            appName,
            source.source_blob.get_url,
            analysis.repository.branch,
            buildpacks
        );

        job.buildId = build.id;
        addJobLog(job, `[Mini Heroku] Build started: ${build.id}`);

        if (build.output_stream_url) {
            // Keep streaming in the background; build status is polled separately.
            streamBuildLogs(job, build.output_stream_url);
        }

        let finalBuild = build;
        let attempts = 0;

        while (
            ["pending", "queued"].includes(finalBuild.status) &&
            attempts < 120
        ) {
            await sleep(5000);
            attempts++;

            finalBuild = await herokuRequest(
                `/apps/${encodeURIComponent(appName)}/builds/${encodeURIComponent(build.id)}`
            );
        }

        if (["pending", "queued"].includes(finalBuild.status)) {
            throw new Error("Build imechukua muda mrefu sana. Angalia Heroku logs.");
        }

        if (finalBuild.status !== "succeeded") {
            throw new Error(`Heroku build failed: ${finalBuild.status}`);
        }

        addJobLog(job, "[Mini Heroku] Build succeeded.");

        job.status = "starting";

        const formation = await applyFormation(appName, analysis.app);

        if (formation) {
            addJobLog(job, "[Mini Heroku] Dyno formation configured.");
        } else {
            addJobLog(job, "[Mini Heroku] Hakuna process ya web/worker iliyopatikana kwenye app.json au Procfile.");
        }

        job.status = "success";

        job.result = {
            app: herokuApp,
            appName,
            url: herokuApp.web_url || `https://${appName}.herokuapp.com`,
            build: finalBuild
        };

        addJobLog(job, `[Mini Heroku] DEPLOYMENT SUCCESS: ${appName}`);

    } catch (error) {
        job.status = "failed";
        job.error = error.message;

        addJobLog(job, `[Mini Heroku] DEPLOYMENT FAILED: ${error.message}`);

        // Clean up only the app created by this deployment job.
        if (job.appName) {
            try {
                addJobLog(job, `[Mini Heroku] Removing failed app: ${job.appName}`);
                await deleteHerokuApp(job.appName);
                addJobLog(job, "[Mini Heroku] Failed app removed.");
            } catch (cleanupError) {
                addJobLog(job, `[Mini Heroku] Cleanup failed: ${cleanupError.message}`);
            }
        }

    } finally {
        if (sourceCleanup) {
            try {
                await sourceCleanup();
            } catch {
                // Ignore temporary-file cleanup failures.
            }
        }

        for (const client of job.clients) {
            try {
                client.write(`data: ${JSON.stringify({
                    type: "complete",
                    status: job.status,
                    error: job.error || null,
                    result: job.result || null
                })}\n\n`);
                client.end();
            } catch {
                // Client disconnected.
            }
        }

        job.clients.clear();
    }
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        success: true,
        status: "ok",
        service: "Mini Heroku",
        configured: Boolean(process.env.HEROKU_API_KEY),
        team: process.env.HEROKU_TEAM || null,
        time: new Date().toISOString()
    });
});

app.get("/api/config-status", (req, res) => {
    res.json({
        apiKeyConfigured: Boolean(process.env.HEROKU_API_KEY),
        teamConfigured: Boolean(process.env.HEROKU_TEAM),
        portConfigured: true,
        uiFound: fs.existsSync(path.join(process.cwd(), "index.html"))
    });
});

/* =========================================================
   ANALYZE ROUTE
========================================================= */

app.post("/api/repository/analyze", async (req, res) => {
    try {
        const repoUrl = getRepoInput(req.body);

        if (!repoUrl) {
            return res.status(400).json({
                success: false,
                error: "Weka GitHub repository URL.",
                message: "Weka GitHub repository URL."
            });
        }

        const result = await analyzeRepository(repoUrl);

        return res.json(result);

    } catch (error) {
        console.error("[ANALYZE ERROR]", error);

        return res.status(400).json({
            success: false,
            error: error.message,
            message: error.message
        });
    }
});

/* =========================================================
   DEPLOY ROUTE
========================================================= */

app.post("/api/deploy", async (req, res) => {
    try {
        const repoUrl = getRepoInput(req.body);
        const env = req.body?.env || {};
        const requestedAppName = String(
            req.body?.appName || req.body?.name || ""
        ).trim();

        if (!repoUrl) {
            return res.status(400).json({
                success: false,
                error: "Weka GitHub repository URL.",
                message: "Weka GitHub repository URL."
            });
        }

        // Validate URL before creating a deployment job.
        parseGithubUrl(repoUrl);

        if (!process.env.HEROKU_API_KEY) {
            return res.status(500).json({
                success: false,
                error: "HEROKU_API_KEY haijawekwa."
            });
        }

        if (!process.env.HEROKU_TEAM) {
            return res.status(500).json({
                success: false,
                error: "HEROKU_TEAM haijawekwa."
            });
        }

        const deploymentId = randomId();

        const job = {
            id: deploymentId,
            status: "queued",
            logs: [],
            clients: new Set(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            appName: null,
            error: null,
            result: null
        };

        deployments.set(deploymentId, job);

        // Do not await: respond immediately while the deployment runs.
        runDeployment(job, repoUrl, env, requestedAppName).catch(error => {
            console.error("[DEPLOY WORKER ERROR]", error);
        });

        return res.status(202).json({
            success: true,
            deploymentId,
            id: deploymentId,
            status: "queued"
        });

    } catch (error) {
        console.error("[DEPLOY REQUEST ERROR]", error);

        return res.status(400).json({
            success: false,
            error: error.message,
            message: error.message
        });
    }
});

/* =========================================================
   DEPLOYMENT STATUS
========================================================= */

app.get("/api/deploy/:id", (req, res) => {
    const job = deployments.get(req.params.id);

    if (!job) {
        return res.status(404).json({
            success: false,
            error: "Deployment haipatikani."
        });
    }

    return res.json({
        success: true,
        id: job.id,
        status: job.status,
        appName: job.appName || null,
        error: job.error || null,
        result: job.result || null,
        logs: job.logs
    });
});

/* =========================================================
   LIVE LOGS
========================================================= */

app.get("/api/deploy/:id/logs", (req, res) => {
    const job = deployments.get(req.params.id);

    if (!job) {
        return res.status(404).end();
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Send current logs in a format the dashboard can display.
    for (const log of job.logs) {
        res.write(`data: ${JSON.stringify({
            type: "log",
            message: log,
            data: log
        })}\n\n`);
    }

    if (["success", "failed"].includes(job.status)) {
        res.write(`data: ${JSON.stringify({
            type: "complete",
            status: job.status,
            error: job.error || null,
            result: job.result || null
        })}\n\n`);

        return res.end();
    }

    job.clients.add(res);

    req.on("close", () => {
        job.clients.delete(res);
    });
});

/* =========================================================
   HEROKU APPS
========================================================= */

app.get("/api/apps", async (req, res) => {
    try {
        const team = process.env.HEROKU_TEAM;

        if (!team) {
            throw new Error("HEROKU_TEAM haijawekwa.");
        }

        const result = await herokuRequest(
            `/teams/${encodeURIComponent(team)}/apps`
        );

        const apps = Array.isArray(result) ? result : [];

        return res.json({
            success: true,
            apps
        });

    } catch (error) {
        console.error("[APPS ERROR]", error);

        return res.status(500).json({
            success: false,
            error: error.message,
            apps: []
        });
    }
});

/* =========================================================
   RESTART APP
========================================================= */

app.post("/api/apps/:name/restart", async (req, res) => {
    try {
        const name = req.params.name;

        await herokuRequest(
            `/apps/${encodeURIComponent(name)}/dynos`,
            { method: "DELETE" }
        );

        return res.json({
            success: true,
            message: `Restart request imetumwa kwa ${name}.`
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/* =========================================================
   DELETE APP
========================================================= */

app.delete("/api/apps/:name", async (req, res) => {
    try {
        await deleteHerokuApp(req.params.name);

        return res.json({
            success: true,
            message: "App imefutwa."
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/* =========================================================
   CLEAN OLD JOBS
========================================================= */

setInterval(() => {
    const now = Date.now();

    for (const [id, job] of deployments) {
        if (
            now - job.createdAt > 60 * 60 * 1000 &&
            job.clients.size === 0
        ) {
            deployments.delete(id);
        }
    }
}, 10 * 60 * 1000);

/* =========================================================
   START SERVER
========================================================= */

app.listen(PORT, () => {
    console.log(`Mini Heroku running on port ${PORT}`);
    console.log(`Heroku API key configured: ${Boolean(process.env.HEROKU_API_KEY)}`);
    console.log(`Heroku Team configured: ${Boolean(process.env.HEROKU_TEAM)}`);
});