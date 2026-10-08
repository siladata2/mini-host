import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { execFile } from "child_process";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
const HEROKU_TEAM = process.env.HEROKU_TEAM;

const execFileAsync = promisify(execFile);

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const deployments = new Map();

function logDeployment(id, message) {
    const deployment = deployments.get(id);
    if (!deployment) return;

    const line = `[${new Date().toISOString()}] ${message}`;

    deployment.logs.push(line);

    if (deployment.logs.length > 1000) {
        deployment.logs.shift();
    }

    console.log(line);
}

function updateDeployment(id, data) {
    const current = deployments.get(id);
    if (!current) return;

    Object.assign(current, data);
}

async function herokuRequest(endpoint, options = {}) {
    if (!HEROKU_API_KEY) {
        throw new Error("HEROKU_API_KEY haijawekwa kwenye .env");
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

    const text = await response.text();

    let data = {};

    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { message: text };
    }

    if (!response.ok) {
        throw new Error(
            data.message ||
            data.error ||
            `Heroku API error: ${response.status}`
        );
    }

    return data;
}

function parseGithubUrl(input) {
    let url;

    try {
        url = new URL(input);
    } catch {
        throw new Error("Weka GitHub repository URL sahihi.");
    }

    if (
        url.hostname !== "github.com" ||
        url.pathname.split("/").filter(Boolean).length < 2
    ) {
        throw new Error(
            "URL lazima iwe ya repository ya GitHub, mfano https://github.com/user/repo"
        );
    }

    const parts = url.pathname.split("/").filter(Boolean);
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/, "");
    const branch = parts.length >= 4 && parts[2] === "tree"
        ? parts.slice(3).join("/")
        : null;

    return { owner, repo, branch };
}

async function githubRequest(url) {
    const response = await fetch(url, {
        headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "Mini-Heroku"
        }
    });

    if (!response.ok) {
        throw new Error(
            `GitHub request imeshindwa (${response.status}). Hakikisha repository ipo na ni public.`
        );
    }

    return response.json();
}

async function getGithubFile(owner, repo, filename, branch) {
    const branches = branch
        ? [branch]
        : ["main", "master"];

    for (const ref of branches) {
        const url =
            `https://raw.githubusercontent.com/` +
            `${owner}/${repo}/${encodeURIComponent(ref)}/` +
            filename;

        try {
            const response = await fetch(url);

            if (response.ok) {
                return await response.text();
            }
        } catch {
            // Jaribu branch inayofuata.
        }
    }

    return null;
}

function parseEnv(text) {
    if (!text) return {};

    const result = {};

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();

        if (!line || line.startsWith("#")) continue;

        const match = line.match(
            /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
        );

        if (!match) continue;

        let value = match[2].trim();

        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        result[match[1]] = value;
    }

    return result;
}

function parseAppJson(text) {
    if (!text) return {};

    try {
        return JSON.parse(text);
    } catch {
        throw new Error(
            "app.json ina makosa ya JSON. Rekebisha faili hilo kwenye GitHub."
        );
    }
}

function detectEnvVars(appJson, packageJson, requirements) {
    const env = new Set();

    if (appJson.env && typeof appJson.env === "object") {
        for (const key of Object.keys(appJson.env)) {
            env.add(key);
        }
    }

    const packageText = packageJson || "";
    const requirementsText = requirements || "";

    const combined = `${packageText}\n${requirementsText}`;

    for (const match of combined.matchAll(
        /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g
    )) {
        env.add(match[1]);
    }

    for (const match of combined.matchAll(
        /os\.environ(?:\.get)?\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g
    )) {
        env.add(match[1]);
    }

    return [...env].sort();
}

async function analyzeRepository(repositoryUrl) {
    const { owner, repo, branch } = parseGithubUrl(repositoryUrl);

    const [appJsonText, packageJsonText, procfile, requirements] =
        await Promise.all([
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

    const detectedEnv = detectEnvVars(
        appJson,
        packageJsonText,
        requirements
    );

    const declaredEnv = appJson.env || {};
    const envVars = detectedEnv.map((key) => {
        const definition = declaredEnv[key] || {};

        return {
            key,
            description: definition.description || "",
            required: definition.required !== false,
            value: ""
        };
    });

    const buildpacks = Array.isArray(appJson.buildpacks)
        ? appJson.buildpacks
            .map((item) => typeof item === "string" ? item : item.url)
            .filter(Boolean)
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

    return result.map((buildpack) => {
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

        const normalized = aliases[buildpack.toLowerCase()] || buildpack;

        if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(normalized)) {
            throw new Error(`Buildpack URL haitambuliki: ${buildpack}`);
        }

        return normalized;
    });
}

async function createHerokuApp(name) {
    if (!HEROKU_TEAM) {
        throw new Error("HEROKU_TEAM haijawekwa kwenye .env");
    }

    return herokuRequest("/teams/apps", {
        method: "POST",
        body: JSON.stringify({
            name,
            team: HEROKU_TEAM,
            region: "us",
            stack: "heroku-24"
        })
    });
}

async function setConfigVars(appName, vars) {
    if (!vars || !Object.keys(vars).length) return;

    await herokuRequest(`/apps/${appName}/config-vars`, {
        method: "PATCH",
        body: JSON.stringify(vars)
    });
}

async function configureBuildpacks(appName, buildpacks) {
    for (let index = 0; index < buildpacks.length; index++) {
        await herokuRequest(`/apps/${appName}/buildpack-installations`, {
            method: "POST",
            body: JSON.stringify({
                buildpack: buildpacks[index],
                ordinal: index + 1
            })
        });
    }
}

async function createSource(appName) {
    return herokuRequest(`/apps/${appName}/sources`, {
        method: "POST"
    });
}

async function uploadSource(sourceUrl, archivePath) {
    const fileBuffer = fs.readFileSync(archivePath);

    const response = await fetch(sourceUrl, {
        method: "PUT",
        body: fileBuffer
    });

    if (!response.ok) {
        const text = await response.text();

        throw new Error(
            `Source upload imeshindwa (${response.status}): ${text}`
        );
    }
}

async function prepareGithubSource(owner, repo, branch, workDir) {
    const archivePath = path.join(workDir, "source.tar.gz");

    const branchesToTry = branch
        ? [branch]
        : ["main", "master"];

    let downloaded = false;
    let selectedBranch = null;

    for (const currentBranch of branchesToTry) {
        const url =
            `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/` +
            encodeURIComponent(currentBranch);

        const response = await fetch(url);

        if (response.ok) {
            const buffer = Buffer.from(await response.arrayBuffer());
            fs.writeFileSync(archivePath, buffer);
            downloaded = true;
            selectedBranch = currentBranch;
            break;
        }
    }

    if (!downloaded) {
        throw new Error(
            "Imeshindwa kupakua source kutoka GitHub. Hakikisha repository ni public na branch ni sahihi."
        );
    }

    const extractDir = path.join(workDir, "extract");
    const outputPath = path.join(workDir, "upload.tar.gz");

    fs.mkdirSync(extractDir, { recursive: true });

    await execFileAsync("tar", [
        "-xzf",
        archivePath,
        "-C",
        extractDir,
        "--strip-components=1"
    ]);

    await execFileAsync("tar", [
        "-czf",
        outputPath,
        "-C",
        extractDir,
        "."
    ]);

    return {
        archivePath: outputPath,
        branch: selectedBranch
    };
}

async function createBuild(appName, sourceBlob) {
    return herokuRequest(`/apps/${appName}/builds`, {
        method: "POST",
        body: JSON.stringify({
            source_blob: {
                url: sourceBlob,
                version: "mini-heroku"
            }
        })
    });
}

async function getBuild(appName, buildId) {
    return herokuRequest(`/apps/${appName}/builds/${buildId}`);
}

async function waitForBuild(appName, buildId, deploymentId) {
    const maxWait = 15 * 60 * 1000;
    const started = Date.now();

    while (Date.now() - started < maxWait) {
        const build = await getBuild(appName, buildId);

        if (build.status === "succeeded") {
            logDeployment(deploymentId, "Build succeeded.");
            return build;
        }

        if (build.status === "failed") {
            throw new Error("Heroku build imeshindwa.");
        }

        logDeployment(
            deploymentId,
            `Build status: ${build.status || "pending"}`
        );

        await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    throw new Error("Build imechukua muda mrefu kupita kiasi.");
}

function buildFormation(analysis) {
    const formation = analysis.formation || {};
    const processes = analysis.processes || {};
    const updates = [];

    for (const [type, config] of Object.entries(formation)) {
        if (!config || typeof config !== "object") continue;

        updates.push({
            type,
            quantity: Number.isInteger(config.quantity)
                ? config.quantity
                : 1,

            // Mini Heroku hutumia Basic ili kuepuka eco dynos
            // ambazo haziruhusiwi kwenye Heroku Teams.
            size: "basic"
        });
    }

    if (!updates.length) {
        const processTypes = Object.keys(processes);

        if (processTypes.includes("web")) {
            updates.push({
                type: "web",
                quantity: 1,
                size: "basic"
            });
        } else if (processTypes.length) {
            updates.push({
                type: processTypes[0],
                quantity: 1,
                size: "basic"
            });
        } else {
            updates.push({
                type: "web",
                quantity: 1,
                size: "basic"
            });
        }
    }

    return updates;
}

async function applyFormation(appName, analysis, deploymentId) {
    const updates = buildFormation(analysis);

    for (const item of updates) {
        logDeployment(
            deploymentId,
            `Configuring ${item.type} dyno: ${item.size} x ${item.quantity}`
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
    } catch (error) {
        console.error("App cleanup failed:", error.message);
    }
}

function makeAppName(base) {
    const cleaned = String(base || "mini-app")
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 25) || "mini-app";

    const suffix = Math.random().toString(36).slice(2, 7);

    return `${cleaned}-${suffix}`.slice(0, 30);
}

async function runDeployment(id, input) {
    let appName = null;
    let success = false;

    try {
        updateDeployment(id, {
            status: "analyzing",
            updatedAt: new Date().toISOString()
        });

        logDeployment(id, "Analyzing GitHub repository...");

        const analysis = await analyzeRepository(input.repositoryUrl);

        const { owner, repo, branch } = parseGithubUrl(
            input.repositoryUrl
        );

        const appEnv = {};

        for (const variable of analysis.envVars) {
            const supplied = input.envVars?.[variable.key];

            if (
                variable.required &&
                !supplied &&
                !Object.prototype.hasOwnProperty.call(
                    input.envVars || {},
                    variable.key
                )
            ) {
                throw new Error(
                    `Environment variable inahitajika: ${variable.key}`
                );
            }

            if (supplied !== undefined && supplied !== "") {
                appEnv[variable.key] = supplied;
            }
        }

        appName = makeAppName(analysis.appName);

        logDeployment(id, `Creating Heroku Team app: ${appName}`);

        const createdApp = await createHerokuApp(appName);
        appName = createdApp.name;

        updateDeployment(id, {
            appName,
            appId: createdApp.id,
            status: "configuring",
            updatedAt: new Date().toISOString()
        });

        logDeployment(id, "Heroku app created.");

        if (Object.keys(appEnv).length) {
            logDeployment(id, "Setting environment variables...");
            await setConfigVars(appName, appEnv);
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
            updateDeployment(id, {
                status: "uploading",
                updatedAt: new Date().toISOString()
            });

            logDeployment(id, "Downloading and preparing GitHub source...");

            const prepared = await prepareGithubSource(
                owner,
                repo,
                branch,
                workDir
            );

            logDeployment(
                id,
                `Uploading source archive from branch ${prepared.branch}...`
            );

            const source = await createSource(appName);

            await uploadSource(
                source.source_blob.put_url,
                prepared.archivePath
            );

            logDeployment(id, "Source uploaded successfully.");

            updateDeployment(id, {
                status: "building",
                updatedAt: new Date().toISOString()
            });

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

        updateDeployment(id, {
            status: "releasing",
            updatedAt: new Date().toISOString()
        });

        logDeployment(id, "Configuring dyno formation...");

        await applyFormation(appName, analysis, id);

        const appInfo = await herokuRequest(`/apps/${appName}`);

        success = true;

        updateDeployment(id, {
            status: "succeeded",
            appName,
            appUrl: appInfo.web_url || `https://${appName}.herokuapp.com`,
            updatedAt: new Date().toISOString()
        });

        logDeployment(id, "DEPLOYMENT SUCCEEDED.");
    } catch (error) {
        updateDeployment(id, {
            status: "failed",
            error: error.message,
            updatedAt: new Date().toISOString()
        });

        logDeployment(id, `DEPLOYMENT FAILED: ${error.message}`);

        if (appName && !success) {
            logDeployment(id, `Cleaning up failed app: ${appName}`);
            await removeApp(appName);
            logDeployment(id, "Cleanup completed.");
        }
    }
}

// Health check
app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        service: "Mini Heroku",
        time: new Date().toISOString()
    });
});

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
        res.status(400).json({
            error: error.message
        });
    }
});

// Start deployment
app.post("/api/deploy", async (req, res) => {
    try {
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
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
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
        res.status(500).json({
            error: error.message
        });
    }
});

// Deployment status
app.get("/api/deploy/:id", (req, res) => {
    const deployment = deployments.get(req.params.id);

    if (!deployment) {
        return res.status(404).json({
            error: "Deployment haijapatikana."
        });
    }

    res.json(deployment);
});

// Deployment logs
app.get("/api/deploy/:id/logs", (req, res) => {
    const deployment = deployments.get(req.params.id);

    if (!deployment) {
        return res.status(404).json({
            error: "Deployment haijapatikana."
        });
    }

    res.json({
        logs: deployment.logs,
        status: deployment.status
    });
});

// List apps belonging to the configured Team
app.get("/api/apps", async (req, res) => {
    try {
        if (!HEROKU_TEAM) {
            throw new Error("HEROKU_TEAM haijawekwa kwenye .env");
        }

        const apps = await herokuRequest(
            `/teams/${encodeURIComponent(HEROKU_TEAM)}/apps`
        );

        res.json({
            ok: true,
            apps
        });
    } catch (error) {
        res.status(400).json({
            error: error.message
        });
    }
});

// Restart an app
app.post("/api/apps/:name/restart", async (req, res) => {
    try {
        await herokuRequest(
            `/apps/${encodeURIComponent(req.params.name)}/dynos`,
            {
                method: "DELETE"
            }
        );

        res.json({
            ok: true,
            message: "App restart imeombwa."
        });
    } catch (error) {
        res.status(400).json({
            error: error.message
        });
    }
});

// Delete an app
app.delete("/api/apps/:name", async (req, res) => {
    try {
        await herokuRequest(
            `/apps/${encodeURIComponent(req.params.name)}`,
            {
                method: "DELETE"
            }
        );

        res.json({
            ok: true,
            message: "App imefutwa."
        });
    } catch (error) {
        res.status(400).json({
            error: error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`Mini Heroku running on port ${PORT}`);
}); 