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

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomId() {
    return `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 9)}`;
}

function herokuHeaders(extra = {}) {
    return {
        Authorization:
            `Bearer ${process.env.HEROKU_API_KEY}`,

        Accept:
            "application/vnd.heroku+json; version=3",

        "Content-Type":
            "application/json",

        ...extra
    };
}

async function herokuRequest(endpoint, options = {}) {

    if (!process.env.HEROKU_API_KEY) {
        throw new Error(
            "HEROKU_API_KEY haijawekwa kwenye .env."
        );
    }

    const response = await fetch(
        `${HEROKU_API}${endpoint}`,
        {
            ...options,

            headers: {
                ...herokuHeaders(),
                ...(options.headers || {})
            }
        }
    );

    const text = await response.text();

    let data;

    try {
        data = text
            ? JSON.parse(text)
            : {};
    } catch {
        data = {
            message: text
        };
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


/* =========================================================
   GITHUB
========================================================= */

function parseGithubUrl(input) {

    let url;

    try {
        url = new URL(
            String(input).trim()
        );
    } catch {
        throw new Error(
            "GitHub repository URL si sahihi."
        );
    }

    if (
        url.protocol !== "https:" ||
        url.hostname !== "github.com"
    ) {
        throw new Error(
            "Tumia public GitHub repository URL kama https://github.com/user/repo"
        );
    }

    const parts =
        url.pathname
            .replace(/^\/|\/$/g, "")
            .split("/");

    if (parts.length < 2) {
        throw new Error(
            "GitHub repository URL si sahihi."
        );
    }

    const owner = parts[0];
    const repo =
        parts[1].replace(/\.git$/, "");

    if (!owner || !repo) {
        throw new Error(
            "GitHub repository URL si sahihi."
        );
    }

    return {
        owner,
        repo,
        url:
            `https://github.com/${owner}/${repo}`
    };
}


async function githubRequest(url) {

    const response = await fetch(
        url,
        {
            headers: {
                Accept:
                    "application/vnd.github+json",

                "User-Agent":
                    "mini-heroku"
            }
        }
    );

    const text =
        await response.text();

    let data;

    try {
        data = text
            ? JSON.parse(text)
            : {};
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
            data.message ||
            `GitHub API Error: ${response.status}`
        );
    }

    return data;
}


async function getGithubRepository(
    owner,
    repo
) {
    return await githubRequest(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    );
}


async function getGithubFile(
    owner,
    repo,
    branch,
    filename
) {

    const url =
        `https://raw.githubusercontent.com/` +
        `${encodeURIComponent(owner)}/` +
        `${encodeURIComponent(repo)}/` +
        `${encodeURIComponent(branch)}/` +
        filename;

    const response =
        await fetch(
            url,
            {
                headers: {
                    "User-Agent":
                        "mini-heroku"
                }
            }
        );

    if (!response.ok) {
        return null;
    }

    return await response.text();
}


/* =========================================================
   APP.JSON ENV
========================================================= */

function parseEnv(appJson) {

    const env =
        appJson?.env || {};

    return Object.entries(env)
        .map(([key, definition]) => {

            if (
                definition &&
                typeof definition === "object" &&
                !Array.isArray(definition)
            ) {

                return {
                    key,

                    required:
                        definition.required !== false,

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

                description:
                    `Value for ${key}`,

                value:
                    definition == null
                        ? ""
                        : String(definition)
            };
        });
}


/* =========================================================
   REPOSITORY ANALYSIS
========================================================= */

async function analyzeRepository(
    repoUrl
) {

    const github =
        parseGithubUrl(repoUrl);

    const repository =
        await getGithubRepository(
            github.owner,
            github.repo
        );

    if (repository.private) {
        throw new Error(
            "Repository hii ni private. Mini Heroku inaruhusu public repositories tu."
        );
    }

    const branch =
        repository.default_branch ||
        "main";

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
            appJson =
                JSON.parse(
                    appJsonText
                );
        } catch {
            throw new Error(
                "app.json ipo lakini JSON yake si sahihi."
            );
        }
    }


    let packageJson = {};

    if (packageJsonText) {

        try {
            packageJson =
                JSON.parse(
                    packageJsonText
                );
        } catch {
            throw new Error(
                "package.json ipo lakini JSON yake si sahihi."
            );
        }
    }


    const env =
        parseEnv(appJson);


    const processes = {};

    if (procfileText) {

        for (
            const line of
            procfileText.split(/\r?\n/)
        ) {

            const match =
                line.match(
                    /^\s*([A-Za-z0-9_-]+)\s*:\s*(.+)$/
                );

            if (match) {

                processes[
                    match[1]
                ] =
                    match[2].trim();
            }
        }
    }


    const formation =
        appJson.formation || {};


    let runtime =
        "unknown";


    if (packageJson.name) {
        runtime = "nodejs";
    }

    else if (requirementsText) {
        runtime = "python";
    }


    if (
        Array.isArray(
            appJson.buildpacks
        ) &&
        appJson.buildpacks.length
    ) {
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

            name:
                repository.name,

            full_name:
                repository.full_name,

            description:
                repository.description ||
                "",

            branch,

            url:
                github.url,

            html_url:
                repository.html_url
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
                appJson.buildpacks ||
                [],

            formation,

            processes,

            startCommand,

            hasAppJson:
                Boolean(appJsonText),

            hasPackageJson:
                Boolean(packageJsonText),

            hasProcfile:
                Boolean(procfileText)
        }
    };
}


/* =========================================================
   TEMP SOURCE
========================================================= */

async function prepareGithubSource(
    owner,
    repo,
    branch
) {

    const tempDir =
        await fs.promises.mkdtemp(
            path.join(
                os.tmpdir(),
                "mini-heroku-"
            )
        );

    const archivePath =
        path.join(
            tempDir,
            "github.tar.gz"
        );

    const outputPath =
        path.join(
            tempDir,
            "source.tar.gz"
        );


    const archiveUrl =
        `https://github.com/` +
        `${encodeURIComponent(owner)}/` +
        `${encodeURIComponent(repo)}` +
        `/archive/refs/heads/` +
        `${encodeURIComponent(branch)}.tar.gz`;


    try {

        const response =
            await fetch(
                archiveUrl,
                {
                    headers: {
                        "User-Agent":
                            "mini-heroku"
                    }
                }
            );

        if (!response.ok) {
            throw new Error(
                `GitHub source download failed: ${response.status}`
            );
        }


        const buffer =
            Buffer.from(
                await response.arrayBuffer()
            );


        await fs.promises.writeFile(
            archivePath,
            buffer
        );


        /*
         * GitHub archive normally contains:
         *
         * repo-branch/
         *     package.json
         *     app.json
         *     ...
         *
         * Heroku needs application files
         * at the archive root.
         *
         * So we extract the archive first,
         * then create a new clean tarball.
         */


        const extractDir =
            path.join(
                tempDir,
                "extract"
            );

        await fs.promises.mkdir(
            extractDir,
            {
                recursive: true
            }
        );


        await execFileAsync(
            "tar",
            [
                "-xzf",
                archivePath,
                "-C",
                extractDir
            ]
        );


        const entries =
            await fs.promises.readdir(
                extractDir,
                {
                    withFileTypes: true
                }
            );


        if (!entries.length) {
            throw new Error(
                "GitHub repository archive iko empty."
            );
        }


        let rootDir =
            extractDir;


        if (
            entries.length === 1 &&
            entries[0].isDirectory()
        ) {
            rootDir =
                path.join(
                    extractDir,
                    entries[0].name
                );
        }


        /*
         * Repack repository contents
         * directly at tar root.
         */

        await execFileAsync(
            "tar",
            [
                "-czf",
                outputPath,
                "-C",
                rootDir,
                "."
            ]
        );


        return {
            file: outputPath,
            cleanup: async () => {

                await fs.promises.rm(
                    tempDir,
                    {
                        recursive: true,
                        force: true
                    }
                );
            }
        };

    } catch (error) {

        await fs.promises.rm(
            tempDir,
            {
                recursive: true,
                force: true
            }
        );

        throw error;
    }
}


/* =========================================================
   HEROKU APP
========================================================= */

async function createHerokuApp(
    name
) {

    const team =
        process.env.HEROKU_TEAM;

    if (!team) {
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

                team,

                region: "us"
            })
        }
    );
}


/* =========================================================
   CONFIG VARS
========================================================= */

async function setConfigVars(
    appName,
    values
) {

    if (
        !values ||
        typeof values !== "object"
    ) {
        return {};
    }


    const clean = {};


    for (
        const [key, value]
        of Object.entries(values)
    ) {

        if (
            !/^[A-Z_][A-Z0-9_]*$/i
                .test(key)
        ) {
            continue;
        }


        if (
            value !== undefined &&
            value !== null &&
            String(value).trim() !== ""
        ) {

            clean[key] =
                String(value);
        }
    }


    if (
        !Object.keys(clean).length
    ) {
        return {};
    }


    return await herokuRequest(
        `/apps/${encodeURIComponent(
            appName
        )}/config-vars`,
        {
            method: "PATCH",

            body:
                JSON.stringify(clean)
        }
    );
}


/* =========================================================
   SOURCE
========================================================= */

async function createSource() {

    return await herokuRequest(
        "/sources",
        {
            method: "POST",

            body:
                JSON.stringify({})
        }
    );
}


async function uploadSource(
    putUrl,
    filePath
) {

    const fileBuffer =
        await fs.promises.readFile(
            filePath
        );


    /*
     * IMPORTANT:
     *
     * Do NOT send Content-Type here.
     *
     * Heroku's put_url is a signed
     * URL. Adding Content-Type can
     * invalidate the signature.
     */

    const upload =
        await fetch(
            putUrl,
            {
                method: "PUT",

                body:
                    fileBuffer
            }
        );


    if (!upload.ok) {

        const text =
            await upload.text();

        throw new Error(
            `Heroku source upload failed: ${text}`
        );
    }


    return true;
}


/* =========================================================
   BUILD
========================================================= */

async function createBuild(
    appName,
    sourceGetUrl,
    version,
    buildpacks
) {

    const body = {

        source_blob: {

            url:
                sourceGetUrl,

            version
        }
    };


    if (
        Array.isArray(buildpacks) &&
        buildpacks.length
    ) {

        body.buildpacks =
            buildpacks.map(
                item => {

                    if (
                        typeof item ===
                        "string"
                    ) {

                        return {
                            url: item
                        };
                    }

                    return item;
                }
            );
    }


    return await herokuRequest(
        `/apps/${encodeURIComponent(
            appName
        )}/builds`,
        {
            method: "POST",

            body:
                JSON.stringify(body)
        }
    );
}


/* =========================================================
   BUILD LOG STREAM
========================================================= */

async function streamBuildLogs(
    job,
    outputUrl
) {

    try {

        const response =
            await fetch(
                outputUrl
            );


        if (
            !response.ok ||
            !response.body
        ) {

            addJobLog(
                job,
                "[Mini Heroku] Build log stream haikupatikana."
            );

            return;
        }


        const reader =
            response.body
                .getReader();

        const decoder =
            new TextDecoder();


        while (true) {

            const {
                value,
                done
            } =
                await reader.read();


            if (done) {
                break;
            }


            const chunk =
                decoder.decode(
                    value,
                    {
                        stream: true
                    }
                );


            if (chunk) {
                addJobLog(
                    job,
                    chunk
                );
            }
        }

    } catch (error) {

        addJobLog(
            job,
            `[Mini Heroku] Log stream error: ${error.message}`
        );
    }
}


/* =========================================================
   JOB LOG
========================================================= */

function addJobLog(
    job,
    message
) {

    job.logs.push(
        message
    );

    job.updatedAt =
        Date.now();


    for (
        const client
        of job.clients
    ) {

        try {

            client.write(
                `data: ${JSON.stringify({
                    type: "log",
                    data: message
                })}\n\n`
            );

        } catch {
            job.clients.delete(
                client
            );
        }
    }
}


/* =========================================================
   FORMATION
========================================================= */

function buildFormation(
    appData
) {

    const formation =
        appData.formation || {};

    const processes =
        appData.processes || {};

    const updates = [];


    for (
        const [type, config]
        of Object.entries(
            formation
        )
    ) {

        if (
            !config ||
            typeof config !== "object"
        ) {
            continue;
        }


        updates.push({

            type,

            quantity:
                Number.isInteger(
                    config.quantity
                )
                    ? config.quantity
                    : 1,

            size:
                config.size ||
                "eco"
        });
    }


    if (!updates.length) {

        /*
         * Bots normally use worker.
         */

        if (processes.worker) {

            updates.push({

                type: "worker",

                quantity: 1,

                size: "eco"
            });

        }

        else if (processes.web) {

            updates.push({

                type: "web",

                quantity: 1,

                size: "eco"
            });
        }
    }


    return updates;
}


async function applyFormation(
    appName,
    appData
) {

    const updates =
        buildFormation(
            appData
        );


    if (!updates.length) {
        return null;
    }


    return await herokuRequest(
        `/apps/${encodeURIComponent(
            appName
        )}/formation`,
        {
            method: "PATCH",

            body:
                JSON.stringify({
                    updates
                })
        }
    );
}


/* =========================================================
   DELETE APP
========================================================= */

async function deleteHerokuApp(
    appName
) {

    if (!appName) {
        return;
    }


    try {

        await herokuRequest(
            `/apps/${encodeURIComponent(
                appName
            )}`,
            {
                method: "DELETE"
            }
        );

        return true;

    } catch (error) {

        throw error;
    }
}


/* =========================================================
   DEPLOYMENT
========================================================= */

async function runDeployment(
    job,
    repoUrl,
    envValues
) {

    let sourceCleanup = null;


    try {

        /* ---------------------------------
           ANALYZE
        --------------------------------- */

        job.status =
            "analyzing";


        addJobLog(
            job,
            "[Mini Heroku] Analyzing repository..."
        );


        const analysis =
            await analyzeRepository(
                repoUrl
            );


        job.analysis =
            analysis;


        addJobLog(
            job,
            `[Mini Heroku] Repository: ${analysis.repository.full_name}`
        );


        addJobLog(
            job,
            `[Mini Heroku] Branch: ${analysis.repository.branch}`
        );


        /* ---------------------------------
           REQUIRED ENV
        --------------------------------- */

        const missing =
            analysis.app.env.filter(
                item => {

                    if (!item.required) {
                        return false;
                    }


                    const submitted =
                        envValues?.[
                            item.key
                        ];


                    const defaultValue =
                        item.value;


                    return (
                        !submitted?.toString()
                            .trim() &&
                        !defaultValue
                    );
                }
            );


        if (missing.length) {

            throw new Error(
                `Environment variables missing: ${
                    missing
                        .map(
                            item =>
                                item.key
                        )
                        .join(", ")
                }`
            );
        }


        /* ---------------------------------
           APP NAME
        --------------------------------- */

        const baseName =
            String(
                analysis.app.name
            )
                .toLowerCase()
                .replace(
                    /[^a-z0-9-]/g,
                    "-"
                )
                .replace(
                    /-+/g,
                    "-"
                )
                .replace(
                    /^-|-$/g,
                    ""
                )
                .slice(0, 25);


        const appName =
            `${baseName || "mini-app"}-${Math.random()
                .toString(36)
                .slice(2, 6)}`;


        job.appName =
            appName;


        /* ---------------------------------
           CREATE APP
        --------------------------------- */

        job.status =
            "creating_app";


        addJobLog(
            job,
            `[Mini Heroku] Creating Team app: ${appName}`
        );


        const herokuApp =
            await createHerokuApp(
                appName
            );


        addJobLog(
            job,
            "[Mini Heroku] Heroku Team app created."
        );


        /* ---------------------------------
           ENV
        --------------------------------- */

        const configVars = {};


        for (
            const item
            of analysis.app.env
        ) {

            const submitted =
                envValues?.[
                    item.key
                ];


            if (
                submitted !== undefined &&
                submitted !== null &&
                String(
                    submitted
                ).trim() !== ""
            ) {

                configVars[
                    item.key
                ] =
                    String(submitted);

            }

            else if (
                item.value !== undefined &&
                item.value !== null &&
                String(
                    item.value
                ).trim() !== ""
            ) {

                configVars[
                    item.key
                ] =
                    String(item.value);
            }
        }


        if (
            Object.keys(
                configVars
            ).length
        ) {

            addJobLog(
                job,
                `[Mini Heroku] Setting ${
                    Object.keys(
                        configVars
                    ).length
                } config vars...`
            );


            await setConfigVars(
                appName,
                configVars
            );
        }


        /* ---------------------------------
           PREPARE SOURCE
        --------------------------------- */

        job.status =
            "preparing_source";


        addJobLog(
            job,
            "[Mini Heroku] Downloading public GitHub source..."
        );


        const github =
            parseGithubUrl(
                repoUrl
            );


        const sourcePackage =
            await prepareGithubSource(
                github.owner,
                github.repo,
                analysis.repository.branch
            );


        sourceCleanup =
            sourcePackage.cleanup;


        addJobLog(
            job,
            "[Mini Heroku] GitHub source prepared."
        );


        /* ---------------------------------
           HEROKU SOURCE
        --------------------------------- */

        job.status =
            "uploading";


        const source =
            await createSource();


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


        /* ---------------------------------
           BUILD
        --------------------------------- */

        job.status =
            "building";


        addJobLog(
            job,
            "[Mini Heroku] Starting Heroku build..."
        );


        const build =
            await createBuild(
                appName,

                source.source_blob
                    .get_url,

                analysis.repository.branch,

                analysis.app.buildpacks
            );


        job.buildId =
            build.id;


        addJobLog(
            job,
            `[Mini Heroku] Build started: ${build.id}`
        );


        let logPromise = null;


        if (
            build.output_stream_url
        ) {

            logPromise =
                streamBuildLogs(
                    job,
                    build.output_stream_url
                );
        }


        /* ---------------------------------
           WAIT BUILD
        --------------------------------- */

        let finalBuild =
            build;


        while (
            finalBuild.status ===
            "pending"
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


        if (logPromise) {
            await logPromise;
        }


        if (
            finalBuild.status !==
            "succeeded"
        ) {

            throw new Error(
                `Heroku build failed with status: ${finalBuild.status}`
            );
        }


        addJobLog(
            job,
            "[Mini Heroku] Build succeeded."
        );


        /* ---------------------------------
           FORMATION
        --------------------------------- */

        job.status =
            "starting";


        const formation =
            await applyFormation(
                appName,
                analysis.app
            );


        if (formation) {

            addJobLog(
                job,
                "[Mini Heroku] Dyno formation configured."
            );
        }


        /* ---------------------------------
           SUCCESS
        --------------------------------- */

        job.status =
            "success";


        job.result = {

            app:
                herokuApp,

            appName,

            url:
                herokuApp.web_url ||
                `https://${appName}.herokuapp.com`,

            build:
                finalBuild
        };


        addJobLog(
            job,
            `[Mini Heroku] DEPLOYMENT SUCCESS: ${appName}`
        );


    } catch (error) {

        /* ---------------------------------
           FAILED
        --------------------------------- */

        job.status =
            "failed";

        job.error =
            error.message;


        addJobLog(
            job,
            `[Mini Heroku] DEPLOYMENT FAILED: ${error.message}`
        );


        /* ---------------------------------
           CLEANUP FAILED APP
        --------------------------------- */

        if (job.appName) {

            addJobLog(
                job,
                `[Mini Heroku] Cleaning up failed app: ${job.appName}`
            );


            try {

                await deleteHerokuApp(
                    job.appName
                );


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
                // Ignore temporary file cleanup errors
            }
        }


        for (
            const client
            of job.clients
        ) {

            try {

                client.write(
                    `data: ${JSON.stringify({
                        type: "complete",

                        status:
                            job.status,

                        error:
                            job.error ||
                            null,

                        result:
                            job.result ||
                            null
                    })}\n\n`
                );

                client.end();

            } catch {
                // Client disconnected
            }
        }


        job.clients.clear();
    }
}


/* =========================================================
   HEALTH
========================================================= */

app.get(
    "/api/health",
    async (req, res) => {

        res.json({

            success: true,

            service:
                "mini-heroku",

            configured:
                Boolean(
                    process.env.HEROKU_API_KEY
                ),

            team:
                process.env.HEROKU_TEAM ||
                null
        });
    }
);


/* =========================================================
   ANALYZE
========================================================= */

app.post(
    "/api/repository/analyze",
    async (req, res) => {

        try {

            const {
                repo
            } = req.body;


            if (!repo) {

                return res.status(400)
                    .json({

                        success: false,

                        error:
                            "Weka GitHub repository URL."
                    });
            }


            const result =
                await analyzeRepository(
                    repo
                );


            res.json(
                result
            );

        } catch (error) {

            res.status(400)
                .json({

                    success: false,

                    error:
                        error.message
                });
        }
    }
);


/* =========================================================
   DEPLOY
========================================================= */

app.post(
    "/api/deploy",
    async (req, res) => {

        try {

            const {
                repo,
                env
            } = req.body;


            if (!repo) {

                return res.status(400)
                    .json({

                        success: false,

                        error:
                            "Weka GitHub repository URL."
                    });
            }


            if (
                !process.env.HEROKU_API_KEY
            ) {

                return res.status(500)
                    .json({

                        success: false,

                        error:
                            "HEROKU_API_KEY haijawekwa."
                    });
            }


            if (
                !process.env.HEROKU_TEAM
            ) {

                return res.status(500)
                    .json({

                        success: false,

                        error:
                            "HEROKU_TEAM haijawekwa."
                    });
            }


            const deploymentId =
                randomId();


            const job = {

                id:
                    deploymentId,

                status:
                    "queued",

                logs: [],

                clients:
                    new Set(),

                createdAt:
                    Date.now(),

                updatedAt:
                    Date.now(),

                appName:
                    null,

                error:
                    null,

                result:
                    null
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

            res.status(500)
                .json({

                    success: false,

                    error:
                        error.message
                });
        }
    }
);


/* =========================================================
   DEPLOYMENT STATUS
========================================================= */

app.get(
    "/api/deploy/:id",
    (req, res) => {

        const job =
            deployments.get(
                req.params.id
            );


        if (!job) {

            return res.status(404)
                .json({

                    success: false,

                    error:
                        "Deployment haipatikani."
                });
        }


        res.json({

            success: true,

            id:
                job.id,

            status:
                job.status,

            appName:
                job.appName ||
                null,

            error:
                job.error ||
                null,

            result:
                job.result ||
                null,

            logs:
                job.logs
        });
    }
);


/* =========================================================
   LIVE LOGS
========================================================= */

app.get(
    "/api/deploy/:id/logs",
    (req, res) => {

        const job =
            deployments.get(
                req.params.id
            );


        if (!job) {
            return res.status(404)
                .end();
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


        /*
         * Send existing logs first.
         */

        for (
            const log
            of job.logs
        ) {

            res.write(
                `data: ${JSON.stringify({
                    type: "log",
                    data: log
                })}\n\n`
            );
        }


        /*
         * Deployment already finished.
         */

        if (
            job.status ===
            "success" ||
            job.status ===
            "failed"
        ) {

            res.write(
                `data: ${JSON.stringify({
                    type: "complete",

                    status:
                        job.status,

                    error:
                        job.error ||
                        null,

                    result:
                        job.result ||
                        null
                })}\n\n`
            );


            return res.end();
        }


        job.clients.add(
            res
        );


        req.on(
            "close",
            () => {
                job.clients.delete(
                    res
                );
            }
        );
    }
);


/* =========================================================
   APPS
========================================================= */

app.get(
    "/api/apps",
    async (req, res) => {

        try {

            const team =
                process.env.HEROKU_TEAM;


            if (!team) {

                throw new Error(
                    "HEROKU_TEAM haijawekwa."
                );
            }


            const apps =
                await herokuRequest(
                    `/teams/${encodeURIComponent(
                        team
                    )}/apps`
                );


            res.json({

                success: true,

                apps
            });


        } catch (error) {

            res.status(500)
                .json({

                    success: false,

                    error:
                        error.message
                });
        }
    }
);


/* =========================================================
   RESTART
========================================================= */

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

            res.status(500)
                .json({

                    success: false,

                    error:
                        error.message
                });
        }
    }
);


/* =========================================================
   DELETE
========================================================= */

app.delete(
    "/api/apps/:name",
    async (req, res) => {

        try {

            await deleteHerokuApp(
                req.params.name
            );


            res.json({

                success: true
            });


        } catch (error) {

            res.status(500)
                .json({

                    success: false,

                    error:
                        error.message
                });
        }
    }
);


/* =========================================================
   CLEAN OLD JOBS
========================================================= */

setInterval(
    () => {

        const now =
            Date.now();


        for (
            const [id, job]
            of deployments
        ) {

            if (
                now - job.createdAt >
                60 * 60 * 1000
            ) {

                deployments.delete(
                    id
                );
            }
        }

    },
    10 * 60 * 1000
);


/* =========================================================
   START SERVER
========================================================= */

app.listen(
    PORT,
    () => {

        console.log(
            `Mini Heroku running on port ${PORT}`
        );
    }
);