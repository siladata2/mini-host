import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { execFile } from "child_process";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const HEROKU_API_KEY = process.env.HEROKU_API_KEY?.trim();
const HEROKU_TEAM = process.env.HEROKU_TEAM?.trim();

const execFileAsync = promisify(execFile);
const deployments = new Map();

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

// index.html iko kwenye root ya repository
app.get("/", (req, res) => {
    const indexPath = path.join(__dirname, "index.html");

    if (!fs.existsSync(indexPath)) {
        console.error("[UI] ERROR: index.html haipo kwenye root.");

        return res.status(404).send(`
            <h1>Mini Heroku UI haijapatikana</h1>
            <p>Hakikisha index.html ipo pamoja na server.js kwenye root.</p>
        `);
    }

    res.sendFile(indexPath);
});

// Static files kama CSS, JS na picha
app.use(express.static(__dirname, {
    index: false,
    dotfiles: "ignore"
}));

// Health check
app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        service: "Mini Heroku",
        time: new Date().toISOString()
    });
});

// Usalama: haionyeshi API key yenyewe
app.get("/api/config-status", (req, res) => {
    res.json({
        apiKeyConfigured: Boolean(HEROKU_API_KEY),
        teamConfigured: Boolean(HEROKU_TEAM),
        portConfigured: Boolean(process.env.PORT),
        uiFound: fs.existsSync(path.join(__dirname, "index.html"))
    });
});

// Logs
function log(message) {
    console.log(
        `[Mini Heroku ${new Date().toISOString()}] ${message}`
    );
}

function logDeployment(id, message) {
    const deployment = deployments.get(id);
    if (!deployment) return;

    const line =
        `[${new Date().toISOString()}] ${message}`;

    deployment.logs.push(line);

    if (deployment.logs.length > 1000) {
        deployment.logs.shift();
    }

    log(`[Deployment ${id}] ${message}`);
}

function updateDeployment(id, updates) {
    const deployment = deployments.get(id);

    if (deployment) {
        Object.assign(deployment, updates);
    }
}

function requireHerokuConfig() {
    if (!HEROKU_API_KEY) {
        throw new Error(
            "HEROKU_API_KEY haijawekwa kwenye environment variables."
        );
    }

    if (!HEROKU_TEAM) {
        throw new Error(
            "HEROKU_TEAM haijawekwa kwenye environment variables."
        );
    }
}

// Heroku API helper
async function herokuRequest(endpoint, options = {}) {
    if (!HEROKU_API_KEY) {
        throw new Error("HEROKU_API_KEY haijawekwa.");
    }

    const response = await fetch(
        `https://api.heroku.com${endpoint}`,
        {
            ...options,
            headers: {
                Accept: "application/vnd.heroku+json; version=3",
                Authorization: `Bearer ${HEROKU_API_KEY}`,
                ...(options.body
                    ? { "Content-Type": "application/json" }
                    : {}),
                ...options.headers
            }
        }
    );

    const responseText = await response.text();

    let data = {};

    try {
        data = responseText ? JSON.parse(responseText) : {};
    } catch {
        data = { message: responseText };
    }

    if (!response.ok) {
        const error = new Error(
            data.message ||
            data.error ||
            `Heroku API error ${response.status}`
        );

        error.status = response.status;

        throw error;
    }

    return data;
}

// Test API key na Team access wakati server inaanza
async function checkHerokuConnection() {
    if (!HEROKU_API_KEY) {
        log("❌ HEROKU_API_KEY haipo.");
        log("Weka API key kwenye Heroku Config Vars.");
        return;
    }

    log("🔑 HEROKU_API_KEY imepatikana.");
    log("🔒 API key imefichwa; haitachapishwa kwenye terminal.");

    try {
        const account = await herokuRequest("/account");

        log("✅ Heroku API key imekubaliwa.");
        log(`✅ Heroku account authenticated: ${account.email || "OK"}`);

        if (HEROKU_TEAM) {
            try {
                const team = await herokuRequest(
                    `/teams/${encodeURIComponent(HEROKU_TEAM)}`
                );

                log(
                    `✅ Heroku Team imeunganishwa: ${team.name || HEROKU_TEAM}`
                );
            } catch (error) {
                log(`⚠️ Team check imeshindwa: ${error.message}`);
            }
        } else {
            log("⚠️ HEROKU_TEAM haijawekwa.");
        }
    } catch (error) {
        if (error.status === 401 || error.status === 403) {
            log("❌ Heroku API key imekataliwa au haina ruhusa.");
        } else {
            log(`❌ Heroku connection error: ${error.message}`);
        }
    }
}

// GitHub repository URL
function parseGithubUrl(input) {
    let url;

    try {
        url = new URL(input);
    } catch {
        throw new Error("Weka GitHub repository URL sahihi.");
    }

    if (url.hostname !== "github.com") {
        throw new Error("URL lazima iwe ya github.com.");
    }

    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length < 2) {
        throw new Error("GitHub URL lazima iwe /owner/repository.");
    }

    return {
        owner: parts[0],
        repo: parts[1].replace(/\.git$/, ""),
        branch: parts[2] === "tree"
            ? parts.slice(3).join("/")
            : null
    };
}

async function getGithubFile(owner, repo, filename, branch) {
    const branches = branch
        ? [branch]
        : ["main", "master"];

    for (const ref of branches) {
        const url =
            `https://raw.githubusercontent.com/${owner}/${repo}/` +
            `${encodeURIComponent(ref)}/${filename}`;

        try {
            const response = await fetch(url);

            if (response.ok) {
                return await response.text();
            }
        } catch {
            // Jaribu branch nyingine.
        }
    }

    return null;
}

function parseAppJson(text) {
    if (!text) return {};

    try {
        return JSON.parse(text);
    } catch {
        throw new Error("app.json ina makosa ya JSON.");
    }
}

function detectEnvVars(appJson, packageText, requirementsText) {
    const keys = new Set();

    if (appJson.env && typeof appJson.env === "object") {
        Object.keys(appJson.env).forEach((key) => keys.add(key));
    }

    const combined =
        `${packageText || ""}\n${requirementsText || ""}`;

    for (const match of combined.matchAll(
        /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g
    )) {
        keys.add(match[1]);
    }

    for (const match of combined.matchAll(
        /os\.environ(?:\.get)?\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g
    )) {
        keys.add(match[1]);
    }

    return [...keys].sort();
}

// Analyze GitHub repository
async function analyzeRepository(repositoryUrl) {
    const { owner, repo, branch } = parseGithubUrl(repositoryUrl);

    const [
        appJsonText,
        packageJsonText,
        procfile,
        requirements
    ] = await Promise.all([
        getGithubFile(owner, repo, "app.json", branch),
        getGithubFile(owner, repo, "package.json", branch),
        getGithubFile(owner, repo, "Procfile", branch),
        getGithubFile(owner, repo, "requirements.txt", branch)
    ]);

    const appJson = parseAppJson(appJsonText);

    let packageJson = {};

    if (packageJsonText) {
        try {
            packageJson = JSON.parse(packageJsonText);
        } catch {
            throw new Error("package.json ina makosa ya JSON.");
        }
    }

    const envVars = detectEnvVars(
        appJson,
        packageJsonText,
        requirements
    ).map((key) => ({
        key,
        description: appJson.env?.[key]?.description || "",
        required: appJson.env?.[key]?.required !== false
    }));

    const buildpacks = Array.isArray(appJson.buildpacks)
        ? appJson.buildpacks.map((item) =>
            typeof item === "string" ? item : item.url
        ).filter(Boolean)
        : [];

    return {
        owner,
        repo,
        branch: branch || "main",
        repositoryUrl,
        appName: appJson.name || repo,
        description: appJson.description || packageJson.description || "",
        envVars,
        buildpacks,
        formation: appJson.formation || {},
        processes: appJson.processes || {},
        hasAppJson: Boolean(appJsonText),
        hasPackageJson: Boolean(packageJsonText),
        hasProcfile: Boolean(procfile),
        hasRequirements: Boolean(requirements)
    };
}

function normalizeBuildpacks(buildpacks, analysis) {
    let result = [...buildpacks];

    if (!result.length) {
        if (analysis.hasPackageJson) {
            result = [
                "https://github.com/heroku/heroku-buildpack-nodejs"
            ];
        } else if (analysis.hasRequirements) {
            result = [
                "https://github.com/heroku/heroku-buildpack-python"
            ];
        }
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
        "heroku/ruby":
            "https://github.com/heroku/heroku-buildpack-ruby"
    };

    return result.map((item) => {
        const normalized = aliases[item.toLowerCase()] || item;

        if (
            !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(normalized)
        ) {
            throw new Error(`Buildpack URL haitambuliki: ${item}`);
        }

        return normalized;
    });
}

async function createHerokuApp(name) {
    requireHerokuConfig();

    return herokuRequest("/teams/apps", {
        method: "POST",
        body: JSON.stringify({
            name,
            team: HEROKU_TEAM,
            region: "us"
        })
    });
}

async function setConfigVars(appName, vars) {
    if (!Object.keys(vars).length) return;

    await herokuRequest(`/apps/${appName}/config-vars`, {
        method: "PATCH",
        body: JSON.stringify(vars)
    });
}

async function configureBuildpacks(appName, buildpacks) {
    for (let index = 0; index < buildpacks.length; index++) {
        await herokuRequest(
            `/apps/${appName}/buildpack-installations`,
            {
                method: "POST",
                body: JSON.stringify({
                    buildpack: buildpacks[index],
                    ordinal: index + 1
                })
            }
        );
    }
}

async function createSource(appName) {
    return herokuRequest(`/apps/${appName}/sources`, {
        method: "POST"
    });
}

async function uploadSource(sourceUrl, archivePath) {
    const buffer = fs.readFileSync(archivePath);

    // Usiongeze Content-Type kwenye signed source URL.
    const response = await fetch(sourceUrl, {
        method: "PUT",
        body: buffer
    });

    if (!response.ok) {
        throw new Error(
            `Source upload imeshindwa: HTTP ${response.status}`
        );
    }
}

async function prepareGithubSource(owner, repo, branch, workDir) {
    const originalArchive = path.join(workDir, "source.tar.gz");
    const uploadArchive = path.join(workDir, "upload.tar.gz");
    const extractDir = path.join(workDir, "extract");

    const branches = branch ? [branch] : ["main", "master"];

    let downloaded = false;
    let selectedBranch = null;

    for (const ref of branches) {
        const url =
            `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/` +
            encodeURIComponent(ref);

        const response = await fetch(url);

        if (response.ok) {
            fs.writeFileSync(
                originalArchive,
                Buffer.from(await response.arrayBuffer())
            );

            downloaded = true;
            selectedBranch = ref;
            break;
        }
    }

    if (!downloaded) {
        throw new Error(
            "Imeshindwa kupakua GitHub source. Hakikisha repository ni public."
        );
    }

    fs.mkdirSync(extractDir, { recursive: true });

    await execFileAsync("tar", [
        "-xzf",
        originalArchive,
        "-C",
        extractDir,
        "--strip-components=1"
    ]);

    await execFileAsync("tar", [
        "-czf",
        uploadArchive,
        "-C",
        extractDir,
        "."
    ]);

    return {
        archivePath: uploadArchive,
        branch: selectedBranch
    };
}

async function createBuild(appName, sourceBlobUrl) {
    return herokuRequest(`/apps/${appName}/builds`, {
        method: "POST",
        body: JSON.stringify({
            source_blob: {
                url: sourceBlobUrl,
                version: "mini-heroku"
            }
        })
    });
}

async function waitForBuild(appName, buildId, id) {
    const deadline = Date.now() + 15 * 60 * 1000;

    while (Date.now() < deadline) {
        const build = await herokuRequest(
            `/apps/${appName}/builds/${buildId}`
        );

        if (build.status === "succeeded") {
            logDeployment(id, "Build succeeded.");
            return;
        }

        if (build.status === "failed") {
            throw new Error("Heroku build imeshindwa.");
        }

        logDeployment(
            id,
            `Build status: ${build.status || "pending"}`
        );

        await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    throw new Error("Build imezidi muda wa kusubiri.");
}

function buildFormation(analysis) {
    const updates = [];

    for (const [type, config] of Object.entries(analysis.formation || {})) {
        if (!config || typeof config !== "object") continue;

        updates.push({
            type,
            quantity: Number.isInteger(config.quantity)
                ? config.quantity
                : 1,
            size: "basic"
        });
    }

    if (!updates.length) {
        const processes = Object.keys(analysis.processes || {});
        const type = processes.includes("web")
            ? "web"
            : processes[0] || "web";

        updates.push({
            type,
            quantity: 1,
            size: "basic"
        });
    }

    return updates;
}

async function applyFormation(appName, analysis, id) {
    for (const item of buildFormation(analysis)) {
        logDeployment(
            id,
            `Setting ${item.type} dyno to Basic x ${item.quantity}`
        );

        await herokuRequest(
            `/apps/${appName}/formation/${item.type}`,
            {
                method: "PATCH",
                body: JSON.stringify({
                    quantity: item.quantity,
                    size: item.size
                })
            }
        );
    }
}

async function removeApp(appName) {
    try {
        await herokuRequest(`/apps/${appName}`, {
            method: "DELETE"
        });

        log(`Cleaned up failed app: ${appName}`);
    } catch (error) {
        log(`Cleanup warning: ${error.message}`);
    }
}

function makeAppName(base) {
    const safe = String(base || "mini-app")
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 24) || "mini-app";

    return `${safe}-${Math.random().toString(36).slice(2, 7)}`;
}

// Deployment pipeline
async function runDeployment(id, input) {
    let appName = null;

    try {
        updateDeployment(id, { status: "analyzing" });
        logDeployment(id, "Analyzing GitHub repository...");

        const analysis = await analyzeRepository(input.repositoryUrl);
        const { owner, repo, branch } = parseGithubUrl(input.repositoryUrl);

        const configVars = {};

        for (const variable of analysis.envVars) {
            const value = input.envVars?.[variable.key];

            if (
                variable.required &&
                (value === undefined || value === "")
            ) {
                throw new Error(
                    `Environment variable inahitajika: ${variable.key}`
                );
            }

            if (value !== undefined && value !== "") {
                configVars[variable.key] = value;
            }
        }

        appName = makeAppName(analysis.appName);

        logDeployment(id, `Creating Team app: ${appName}`);

        const created = await createHerokuApp(appName);
        appName = created.name;

        updateDeployment(id, {
            appName,
            appId: created.id,
            status: "configuring"
        });

        if (Object.keys(configVars).length) {
            logDeployment(id, "Setting environment variables...");
            await setConfigVars(appName, configVars);
        }

        const buildpacks = normalizeBuildpacks(
            analysis.buildpacks,
            analysis
        );

        if (buildpacks.length) {
            logDeployment(id, "Configuring buildpacks...");
            await configureBuildpacks(appName, buildpacks);
        }

        const workDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "mini-heroku-")
        );

        try {
            updateDeployment(id, { status: "uploading" });
            logDeployment(id, "Preparing GitHub source...");

            const prepared = await prepareGithubSource(
                owner,
                repo,
                branch,
                workDir
            );

            const source = await createSource(appName);

            await uploadSource(
                source.source_blob.put_url,
                prepared.archivePath
            );

            logDeployment(id, "Source uploaded.");

            updateDeployment(id, { status: "building" });
            logDeployment(id, "Starting Heroku build...");

            const build = await createBuild(
                appName,
                source.source_blob.get_url
            );

            await waitForBuild(appName, build.id, id);
        } finally {
            fs.rmSync(workDir, {
                recursive: true,
                force: true
            });
        }

        updateDeployment(id, { status: "releasing" });

        await applyFormation(appName, analysis, id);

        const info = await herokuRequest(`/apps/${appName}`);

        updateDeployment(id, {
            status: "succeeded",
            appUrl: info.web_url ||
                `https://${appName}.herokuapp.com`,
            updatedAt: new Date().toISOString()
        });

        logDeployment(id, "✅ DEPLOYMENT SUCCEEDED.");
    } catch (error) {
        updateDeployment(id, {
            status: "failed",
            error: error.message,
            updatedAt: new Date().toISOString()
        });

        logDeployment(id, `❌ DEPLOYMENT FAILED: ${error.message}`);

        if (appName) {
            logDeployment(id, `Cleaning up failed app: ${appName}`);
            await removeApp(appName);
        }
    }
}

// Analyze repository
app.post("/api/repository/analyze", async (req, res) => {
    try {
        const { repositoryUrl } = req.body || {};

        if (!repositoryUrl) {
            return res.status(400).json({
                error: "Weka GitHub repository URL."
            });
        }

        const analysis = await analyzeRepository(repositoryUrl);

        res.json({
            ok: true,
            analysis
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Start deployment
app.post("/api/deploy", async (req, res) => {
    try {
        requireHerokuConfig();

        const { repositoryUrl, envVars = {} } = req.body || {};

        if (!repositoryUrl) {
            return res.status(400).json({
                error: "GitHub repository URL inahitajika."
            });
        }

        if (
            !envVars ||
            typeof envVars !== "object" ||
            Array.isArray(envVars)
        ) {
            return res.status(400).json({
                error: "envVars lazima iwe object."
            });
        }

        const id = `${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;

        deployments.set(id, {
            id,
            status: "queued",
            repositoryUrl,
            appName: null,
            appUrl: null,
            logs: [],
            createdAt: new Date().toISOString()
        });

        res.status(202).json({
            ok: true,
            deploymentId: id,
            status: "queued"
        });

        runDeployment(id, {
            repositoryUrl,
            envVars
        }).catch((error) => {
            logDeployment(id, `Unexpected error: ${error.message}`);
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Deployment status
app.get("/api/deploy/:id", (req, res) => {
    const item = deployments.get(req.params.id);

    if (!item) {
        return res.status(404).json({
            error: "Deployment haijapatikana."
        });
    }

    res.json(item);
});

// Deployment logs
app.get("/api/deploy/:id/logs", (req, res) => {
    const item = deployments.get(req.params.id);

    if (!item) {
        return res.status(404).json({
            error: "Deployment haijapatikana."
        });
    }

    res.json({
        logs: item.logs,
        status: item.status
    });
});

// Apps za Team
app.get("/api/apps", async (req, res) => {
    try {
        requireHerokuConfig();

        const apps = await herokuRequest(
            `/teams/${encodeURIComponent(HEROKU_TEAM)}/apps`
        );

        res.json({ ok: true, apps });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Restart app
app.post("/api/apps/:name/restart", async (req, res) => {
    try {
        await herokuRequest(
            `/apps/${encodeURIComponent(req.params.name)}/dynos`,
            { method: "DELETE" }
        );

        res.json({
            ok: true,
            message: "Restart imeombwa."
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Delete app
app.delete("/api/apps/:name", async (req, res) => {
    try {
        await herokuRequest(
            `/apps/${encodeURIComponent(req.params.name)}`,
            { method: "DELETE" }
        );

        res.json({
            ok: true,
            message: "App imefutwa."
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Error handler
app.use((err, req, res, next) => {
    log(`Express error: ${err.message}`);

    if (res.headersSent) {
        return next(err);
    }

    res.status(500).json({
        error: "Server error",
        message: err.message
    });
});

// Start server
app.listen(PORT, () => {
    log("====================================");
    log("🚀 MINI HEROKU SERVER STARTED");
    log(`🌐 Port: ${PORT}`);
    log(`📄 index.html found: ${
        fs.existsSync(path.join(__dirname, "index.html"))
    }`);
    log(`🔑 API key configured: ${Boolean(HEROKU_API_KEY)}`);
    log(`👥 Team configured: ${Boolean(HEROKU_TEAM)}`);
    log("====================================");

    checkHerokuConnection().catch((error) => {
        log(`❌ Heroku startup check failed: ${error.message}`);
    });
});