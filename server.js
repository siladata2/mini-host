import "dotenv/config";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const HEROKU_API = "https://api.heroku.com";

app.use(express.json({ limit: "2mb" }));
app.use(express.static("."));

const deployments = new Map();

/* =====================================================
   GENERAL HELPERS
===================================================== */

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function addJobLog(job, message) {
    job.logs.push(String(message));
    job.updatedAt = Date.now();

    for (const client of job.clients) {
        try {
            client.write(
                `data: ${JSON.stringify({
                    type: "log",
                    data: String(message)
                })}\n\n`
            );
        } catch {
            job.clients.delete(client);
        }
    }
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
        throw new Error("HEROKU_API_KEY haijawekwa kwenye .env.");
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
        throw new Error(
            data.message ||
            data.error ||
            `Heroku API Error: ${response.status}`
        );
    }

    return data;
}

/* =====================================================
   GITHUB REPOSITORY
===================================================== */

function parseGithubUrl(input) {
    let url;

    try {
        url = new URL(String(input).trim());
    } catch {
        throw new Error("GitHub repository URL si sahihi.");
    }

    if (
        url.protocol !== "https:" ||
        url.hostname !== "github.com"
    ) {
        throw new Error(
            "Tumia public GitHub URL, mfano https://github.com/user/repo"
        );
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
        data = text ? JSON.parse(text) : {};
    } catch {
        data = {};
    }

    if (!response.ok) {
        if (response.status === 404) {
            throw new Error(
                "Repository haipo au si public."
            );
        }

        throw new Error(
            data.message || `GitHub API Error: ${response.status}`
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

/* =====================================================
   APP.JSON ENVIRONMENT VARIABLES
===================================================== */

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
                    definition.description || `Value for ${key}`,
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
                definition == null
                    ? ""
                    : String(definition)
        };
    });
}

/* =====================================================
   ANALYZE REPOSITORY
===================================================== */

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
    let packageJson = {};

    if (appJsonText) {
        try {
            appJson = JSON.parse(appJsonText);
        } catch {
            throw new Error("Muundo wa app.json si sahihi.");
        }
    }

    if (packageJsonText) {
        try {
            packageJson = JSON.parse(packageJsonText);
        } catch {
            throw new Error("Muundo wa package.json si sahihi.");
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

    if (packageJson.name || packageJson.dependencies) {
        runtime = "nodejs";
    } else if (requirementsText) {
        runtime = "python";
    }

    if (
        Array.isArray(appJson.buildpacks) &&
        appJson.buildpacks.length
    ) {
        runtime = "custom";
    }

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
            name: appJson.name || repository.name,
            description:
                appJson.description ||
                repository.description ||
                "",
            runtime,
            env: parseEnv(appJson),
            buildpacks: appJson.buildpacks || [],
            formation: appJson.formation || {},
            processes,
            startCommand:
                processes.worker ||
                processes.web ||
                packageJson.scripts?.start ||
                null,
            hasAppJson: Boolean(appJsonText),
            hasPackageJson: Boolean(packageJsonText),
            hasProcfile: Boolean(procfileText)
        }
    };
}

/* =====================================================
   NORMALIZE HEROKU BUILDPACKS
===================================================== */

function normalizeBuildpacks(buildpacks) {
    if (!Array.isArray(buildpacks)) {
        return [];
    }

    return buildpacks.map(item => {
        const value =
            typeof item === "string"
                ? item
                : item?.url;

        if (!value || typeof value !== "string") {
            throw new Error("Buildpack haijawekwa vizuri kwenye app.json.");
        }

        const aliases = {
            "heroku/nodejs":
                "https://github.com/heroku/heroku-buildpack-nodejs",

            "nodejs":
                "https://github.com/heroku/heroku-buildpack-nodejs",

            "heroku/python":
                "https://github.com/heroku/heroku-buildpack-python",

            "python":
                "https://github.com/heroku/heroku-buildpack-python",

            "heroku/java":
                "https://github.com/heroku/heroku-buildpack-java",

            "java":
                "https://github.com/heroku/heroku-buildpack-java",

            "heroku/ruby":
                "https://github.com/heroku/heroku-buildpack-ruby",

            "ruby":
                "https://github.com/heroku/heroku-buildpack-ruby"
        };

        const normalized = aliases[value] || value;

        if (
            !/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(
                normalized
            )
        ) {
            throw new Error(
                `Buildpack URL haitambuliki: ${value}`
            );
        }

        return {
            url: normalized
        };
    });
}

/* =====================================================
   CREATE HEROKU TEAM APP
===================================================== */

async function createHerokuApp(name) {
    const team = process.env.HEROKU_TEAM;

    if (!team) {
        throw new Error("HEROKU_TEAM haijawekwa kwenye .env.");
    }

    return await herokuRequest("/teams/apps", {
        method: "POST",
        body: JSON.stringify({
            name,
            team,
            region: "us"
        })
    });
}

/* =====================================================
   CONFIG VARS
===================================================== */

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

/* =====================================================
   SOURCE BLOB
===================================================== */

async function createSource() {
    return await herokuRequest("/sources", {
        method: "POST",
        body: JSON.stringify({})
    });
}

async function uploadSource(putUrl, filePath) {
    const fileBuffer = await fs.promises.readFile(filePath);

    /*
     * Usiongeze Content-Type kwenye PUT hii.
     * Heroku source URL ni signed URL.
     */

    const upload = await fetch(putUrl, {
        method: "PUT",
        body: fileBuffer
    });

    if (!upload.ok) {
        const text = await upload.text();

        throw new Error(
            `Heroku source upload failed: ${text}`
        );
    }

    return true;
}

/* =====================================================
   DOWNLOAD, EXTRACT AND REPACK GITHUB ARCHIVE
===================================================== */

async function prepareGithubSource(owner, repo, branch) {
    const tempDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "mini-heroku-")
    );

    const archivePath = path.join(tempDir, "github.tar.gz");
    const outputPath = path.join(tempDir, "source.tar.gz");
    const extractDir = path.join(tempDir, "extract");

    try {
        const archiveUrl =
            `https://codeload.github.com/` +
            `${encodeURIComponent(owner)}/` +
            `${encodeURIComponent(repo)}/` +
            `tar.gz/refs/heads/${encodeURIComponent(branch)}`;

        const response = await fetch(archiveUrl, {
            headers: {
                "User-Agent": "mini-heroku"
            }
        });

        if (!response.ok) {
            throw new Error(
                `GitHub source download failed: ${response.status}`
            );
        }

        const buffer = Buffer.from(
            await response.arrayBuffer()
        );

        await fs.promises.writeFile(archivePath, buffer);

        await fs.promises.mkdir(extractDir, {
            recursive: true
        });

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
            throw new Error("GitHub archive iko empty.");
        }

        let rootDir = extractDir;

        if (
            entries.length === 1 &&
            entries[0].isDirectory()
        ) {
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

/* =====================================================
   CREATE BUILD
===================================================== */

async function createBuild(
    appName,
    sourceGetUrl,
    version,
    buildpacks
) {
    const body = {
        source_blob: {
            url: sourceGetUrl,
            version
        }
    };

    const normalizedBuildpacks =
        normalizeBuildpacks(buildpacks);

    if (normalizedBuildpacks.length) {
        body.buildpacks = normalizedBuildpacks;
    }

    return await herokuRequest(
        `/apps/${encodeURIComponent(appName)}/builds`,
        {
            method: "POST",
            body: JSON.stringify(body)
        }
    );
}

/* =====================================================
   STREAM BUILD LOGS
===================================================== */

async function streamBuildLogs(job, outputUrl) {
    try {
        const response = await fetch(outputUrl);

        if (!response.ok || !response.body) {
            addJobLog(
                job,
                "[Mini Heroku] Build log stream haikupatikana."
            );
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { value, done } = await reader.read();

            if (done) {
                break;
            }

            const chunk = decoder.decode(value, {
                stream: true
            });

            if (chunk) {
                addJobLog(job, chunk);
            }
        }
    } catch (error) {
        addJobLog(
            job,
            `[Mini Heroku] Log stream error: ${error.message}`
        );
    }
}

/* =====================================================
   DYNO FORMATION
===================================================== */

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
            quantity: Number.isInteger(config.quantity)
                ? config.quantity
                : 1,
            size: config.size || "eco"
        });
    }

    if (!updates.length) {
        if (processes.worker) {
            updates.push({
                type: "worker",
                quantity: 1,
                size: "eco"
            });
        } else if (processes.web) {
            updates.push({
                type: "web",
                quantity: 1,
                size: "eco"
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
            body: JSON.stringify({ updates })
        }
    );
}

/* =====================================================
   DELETE APP
===================================================== */

async function deleteHerokuApp(appName) {
    if (!appName) {
        return;
    }

    return await herokuRequest(
        `/apps/${encodeURIComponent(appName)}`,
        {
            method: "DELETE"
        }
    );
}

/* =====================================================
   DEPLOYMENT WORKER
===================================================== */

async function runDeployment(job, repoUrl, envValues) {
    let sourceCleanup = null;

    try {
        job.status = "analyzing";

        addJobLog(
            job,
            "[Mini Heroku] Analyzing repository..."
        );

        const analysis = await analyzeRepository(repoUrl);

        job.analysis = analysis;

        addJobLog(
            job,
            `[Mini Heroku] Repository: ${analysis.repository.full_name}`
        );

        addJobLog(
            job,
            `[Mini Heroku] Branch: ${analysis.repository.branch}`
        );

        /*
         * Required variables
         */

        const missing = analysis.app.env.filter(item => {
            if (!item.required) {
                return false;
            }

            const submitted = envValues?.[item.key];
            const defaultValue = item.value;

            return (
                !String(submitted ?? "").trim() &&
                !String(defaultValue ?? "").trim()
            );
        });

        if (missing.length) {
            throw new Error(
                `Environment variables missing: ${
                    missing.map(item => item.key).join(", ")
                }`
            );
        }

        /*
         * App name
         */

        const baseName = String(analysis.app.name)
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

        /*
         * Create Team app
         */

        job.status = "creating_app";

        addJobLog(
            job,
            `[Mini Heroku] Creating Team app: ${appName}`
        );

        const herokuApp = await createHerokuApp(appName);

        addJobLog(
            job,
            "[Mini Heroku] Heroku Team app created."
        );

        /*
         * Config vars
         */

        const configVars = {};

        for (const item of analysis.app.env) {
            const submitted = envValues?.[item.key];

            if (
                submitted !== undefined &&
                submitted !== null &&
                String(submitted).trim() !== ""
            ) {
                configVars[item.key] = String(submitted);
            } else if (
                item.value !== undefined &&
                item.value !== null &&
                String(item.value).trim() !== ""
            ) {
                configVars[item.key] = String(item.value);
            }
        }

        if (Object.keys(configVars).length) {
            addJobLog(
                job,
                `[Mini Heroku] Setting ${Object.keys(configVars).length} config vars...`
            );

            await setConfigVars(appName, configVars);
        }

        /*
         * Prepare GitHub source
         */

        job.status = "preparing_source";

        addJobLog(
            job,
            "[Mini Heroku] Downloading public GitHub source..."
        );

        const github = parseGithubUrl(repoUrl);

        const sourcePackage = await prepareGithubSource(
            github.owner,
            github.repo,
            analysis.repository.branch
        );

        sourceCleanup = sourcePackage.cleanup;

        addJobLog(
            job,
            "[Mini Heroku] GitHub source prepared."
        );

        /*
         * Upload source
         */

        job.status = "uploading";

        const source = await createSource();

        addJobLog(
            job,
            "[Mini Heroku] Uploading source to Heroku..."
        );

        await uploadSource(
            source.source_blob.put_url,
            sourcePackage.file
        );

        addJobLog(
            job,
            "[Mini Heroku] Source uploaded successfully."
        );

        /*
         * Start build
         */

        job.status = "building";

        addJobLog(
            job,
            "[Mini Heroku] Starting Heroku build..."
        );

        const build = await createBuild(
            appName,
            source.source_blob.get_url,
            analysis.repository.branch,
            analysis.app.buildpacks
        );

        job.buildId = build.id;

        addJobLog(
            job,
            `[Mini Heroku] Build started: ${build.id}`
        );

        let logPromise = null;

        if (build.output_stream_url) {
            logPromise = streamBuildLogs(
                job,
                build.output_stream_url
            );
        }

        /*
         * Poll build status
         */

        let finalBuild = build;

        while (
            finalBuild.status === "pending" ||
            finalBuild.status === "queued"
        ) {
            await sleep(3000);

            finalBuild = await herokuRequest(
                `/apps/${encodeURIComponent(appName)}/builds/${encodeURIComponent(build.id)}`
            );
        }

        if (logPromise) {
            await logPromise;
        }

        if (finalBuild.status !== "succeeded") {
            throw new Error(
                `Heroku build failed with status: ${finalBuild.status}`
            );
        }

        addJobLog(
            job,
            "[Mini Heroku] Build succeeded."
        );

        /*
         * Configure formation
         */

        job.status = "starting";

        await applyFormation(
            appName,
            analysis.app
        );

        addJobLog(
            job,
            "[Mini Heroku] Formation configuration completed."
        );

        /*
         * Success
         */

        job.status = "success";

        job.result = {
            app: herokuApp,
            appName,
            url:
                herokuApp.web_url ||
                `https://${appName}.herokuapp.com`,
            build: finalBuild
        };

        addJobLog(
            job,
            `[Mini Heroku] DEPLOYMENT SUCCESS: ${appName}`
        );
    } catch (error) {
        job.status = "failed";
        job.error = error.message;

        addJobLog(
            job,
            `[Mini Heroku] DEPLOYMENT FAILED: ${error.message}`
        );

        /*
         * Remove only the app created by this job.
         */

        if (job.appName) {
            addJobLog(
                job,
                `[Mini Heroku] Cleaning up failed app: ${job.appName}`
            );

            try {
                await deleteHerokuApp(job.appName);

                addJobLog(
                    job,
                    "[Mini Heroku] Failed app removed successfully."
                );
            } catch (cleanupError) {
                addJobLog(
                    job,
                    `[Mini Heroku] Cleanup failed: ${cleanupError.message}`
                );
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
                client.write(
                    `data: ${JSON.stringify({
                        type: "complete",
                        status: job.status,
                        error: job.error || null,
                        result: job.result || null
                    })}\n\n`
                );

                client.end();
            } catch {
                // Client disconnected.
            }
        }

        job.clients.clear();
    }
}

/* =====================================================
   HEALTH CHECK
===================================================== */

app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        service: "mini-heroku",
        configured: Boolean(process.env.HEROKU_API_KEY),
        team: process.env.HEROKU_TEAM || null
    });
});

/* =====================================================
   ANALYZE REPOSITORY API
===================================================== */

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

/* =====================================================
   DEPLOY API
===================================================== */

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

        addJobLog(
            job,
            "[Mini Heroku] Deployment queued..."
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

/* =====================================================
   DEPLOYMENT STATUS
===================================================== */

app.get("/api/deploy/:id", (req, res) => {
    const job = deployments.get(req.params.id);

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
        appName: job.appName,
        error: job.error,
        result: job.result,
        logs: job.logs
    });
});

/* =====================================================
   LIVE LOGS SSE
===================================================== */

app.get("/api/deploy/:id/logs", (req, res) => {
    const job = deployments.get(req.params.id);

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
});

/* =====================================================
   LIST TEAM APPS
===================================================== */

app.get("/api/apps", async (req, res) => {
    try {
        const team = process.env.HEROKU_TEAM;

        if (!team) {
            throw new Error(
                "HEROKU_TEAM haijawekwa kwenye .env."
            );
        }

        const apps = await herokuRequest(
            `/teams/${encodeURIComponent(team)}/apps`
        );

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

/* =====================================================
   RESTART APP
===================================================== */

app.post("/api/apps/:name/restart", async (req, res) => {
    try {
        await herokuRequest(
            `/apps/${encodeURIComponent(req.params.name)}/dynos`,
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
});

/* =====================================================
   DELETE APP
===================================================== */

app.delete("/api/apps/:name", async (req, res) => {
    try {
        await deleteHerokuApp(req.params.name);

        res.json({
            success: true
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/* =====================================================
   CLEAN OLD JOBS
===================================================== */

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

/* =====================================================
   START SERVER
===================================================== */

app.listen(PORT, () => {
    console.log(
        `Mini Heroku running on port ${PORT}`
    );
});