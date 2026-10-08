import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";

import {
    createApp,
    getApps,
    getApp,
    deleteApp,
    restartApp
} from "./heroku.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(process.cwd()));


/* =========================
   HOME
========================= */

app.get("/", (req, res) => {
    res.sendFile(
        path.join(process.cwd(), "index.html")
    );
});


/* =========================
   HEALTH
========================= */

app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        heroku: Boolean(
            process.env.HEROKU_API_KEY
        ),
        team: process.env.HEROKU_TEAM || null
    });
});


/* =========================
   GET APPS
========================= */

app.get("/api/apps", async (req, res) => {

    try {

        const apps = await getApps();

        res.json({
            success: true,
            apps: apps.map(app => ({
                id: app.id,
                name: app.name,
                url: app.web_url,
                created: app.created_at,
                updated: app.updated_at
            }))
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});


/* =========================
   GET ONE APP
========================= */

app.get("/api/apps/:name", async (req, res) => {

    try {

        const result =
            await getApp(req.params.name);

        res.json({
            success: true,
            app: result
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});


/* =========================
   CREATE APP
========================= */

app.post("/api/apps", async (req, res) => {

    try {

        const { name } = req.body;

        if (!name) {

            return res.status(400).json({
                success: false,
                error: "App name is required"
            });

        }

        const result =
            await createApp(name);

        res.json({
            success: true,
            app: result
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});


/* =========================
   GIT REPOSITORY DEPLOY
========================= */

app.post(
    "/api/deploy",
    async (req, res) => {

        let repoDirectory = null;

        try {

            const {
                repo,
                name,
                branch,
                startCommand,
                env
            } = req.body;


            /* -------------------------
               VALIDATE REPO
            ------------------------- */

            if (!repo) {

                return res.status(400).json({
                    success: false,
                    error:
                        "Repository URL is required."
                });

            }


            if (
                !repo.startsWith(
                    "https://github.com/"
                ) &&
                !repo.startsWith(
                    "https://gitlab.com/"
                )
            ) {

                return res.status(400).json({
                    success: false,
                    error:
                        "Only GitHub and GitLab repositories are supported."
                });

            }


            /* -------------------------
               APP NAME
            ------------------------- */

            let appName = String(
                name ||
                "mini-bot-" +
                Date.now()
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
            );

            appName =
                appName.substring(0, 30);


            /* -------------------------
               CLONE DIRECTORY
            ------------------------- */

            repoDirectory =
                path.join(
                    process.cwd(),
                    "repos",
                    "repo-" +
                    crypto.randomUUID()
                );

            fs.mkdirSync(
                repoDirectory,
                {
                    recursive: true
                }
            );


            console.log(
                "Fetching repository:",
                repo
            );


            /* -------------------------
               CLONE REPOSITORY
            ------------------------- */

            const cloneArgs = [
                "clone"
            ];

            if (branch) {

                cloneArgs.push(
                    "--branch",
                    branch
                );

            }

            cloneArgs.push(
                "--depth",
                "1",
                repo,
                repoDirectory
            );


            execFileSync(
                "git",
                cloneArgs,
                {
                    stdio: "pipe"
                }
            );


            console.log(
                "Repository fetched."
            );


            /* -------------------------
               DETECT PROJECT
            ------------------------- */

            const files =
                fs.readdirSync(
                    repoDirectory
                );


            const hasPackageJson =
                fs.existsSync(
                    path.join(
                        repoDirectory,
                        "package.json"
                    )
                );

            const hasRequirements =
                fs.existsSync(
                    path.join(
                        repoDirectory,
                        "requirements.txt"
                    )
                );

            const hasProcfile =
                fs.existsSync(
                    path.join(
                        repoDirectory,
                        "Procfile"
                    )
                );


            let detectedRuntime =
                "unknown";


            if (hasPackageJson) {

                detectedRuntime =
                    "nodejs";

            } else if (
                hasRequirements
            ) {

                detectedRuntime =
                    "python";

            }


            console.log(
                "Detected runtime:",
                detectedRuntime
            );


            /* -------------------------
               CREATE PROCFILE
            ------------------------- */

            const procfilePath =
                path.join(
                    repoDirectory,
                    "Procfile"
                );


            if (
                startCommand &&
                startCommand.trim()
            ) {

                fs.writeFileSync(
                    procfilePath,
                    `worker: ${startCommand.trim()}\n`
                );

            } else if (!hasProcfile) {

                if (
                    detectedRuntime ===
                    "nodejs"
                ) {

                    fs.writeFileSync(
                        procfilePath,
                        "worker: npm start\n"
                    );

                } else if (
                    detectedRuntime ===
                    "python"
                ) {

                    fs.writeFileSync(
                        procfilePath,
                        "worker: python bot.py\n"
                    );

                } else {

                    throw new Error(
                        "Could not detect start command. Please provide one."
                    );

                }

            }


            /* -------------------------
               CREATE HEROKU APP
            ------------------------- */

            console.log(
                "Creating Heroku app:",
                appName
            );


            const herokuApp =
                await createApp(
                    appName
                );


            console.log(
                "Heroku app created:",
                herokuApp.name
            );


            /* -------------------------
               CONFIG VARS
            ------------------------- */

            if (
                env &&
                typeof env === "object"
            ) {

                const cleanEnv = {};

                for (
                    const [key, value]
                    of Object.entries(env)
                ) {

                    if (
                        key &&
                        value !== undefined &&
                        value !== null
                    ) {

                        cleanEnv[
                            String(key)
                        ] =
                            String(value);

                    }

                }


                if (
                    Object.keys(cleanEnv)
                        .length > 0
                ) {

                    const configResponse =
                        await fetch(
                            `https://api.heroku.com/apps/${encodeURIComponent(
                                herokuApp.name
                            )}/config-vars`,
                            {
                                method: "PATCH",

                                headers: {
                                    "Authorization":
                                        `Bearer ${process.env.HEROKU_API_KEY}`,

                                    "Accept":
                                        "application/vnd.heroku+json; version=3",

                                    "Content-Type":
                                        "application/json"
                                },

                                body:
                                    JSON.stringify(
                                        cleanEnv
                                    )
                            }
                        );


                    const configResult =
                        await configResponse.json();


                    if (
                        !configResponse.ok
                    ) {

                        throw new Error(
                            configResult.message ||
                            "Failed to set environment variables."
                        );

                    }

                }

            }


            /* -------------------------
               CREATE SOURCE ARCHIVE
            ------------------------- */

            const tarFile =
                path.join(
                    process.cwd(),
                    "repos",
                    "source-" +
                    crypto.randomUUID() +
                    ".tar.gz"
                );


            execFileSync(
                "tar",
                [
                    "-czf",
                    tarFile,
                    "-C",
                    repoDirectory,
                    "."
                ]
            );


            /* -------------------------
               CREATE HEROKU SOURCE
            ------------------------- */

            const sourceResponse =
                await fetch(
                    "https://api.heroku.com/sources",
                    {
                        method: "POST",

                        headers: {
                            "Authorization":
                                `Bearer ${process.env.HEROKU_API_KEY}`,

                            "Accept":
                                "application/vnd.heroku+json; version=3",

                            "Content-Type":
                                "application/json"
                        },

                        body: "{}"
                    }
                );


            const source =
                await sourceResponse.json();


            if (
                !sourceResponse.ok
            ) {

                throw new Error(
                    source.message ||
                    "Could not create Heroku source."
                );

            }


            /* -------------------------
               UPLOAD SOURCE
            ------------------------- */

            const sourceBuffer =
                fs.readFileSync(
                    tarFile
                );


            const uploadResponse =
                await fetch(
                    source.source_blob.put_url,
                    {
                        method: "PUT",

                        headers: {
                            "Content-Type":
                                "application/octet-stream"
                        },

                        body: sourceBuffer
                    }
                );


            if (
                !uploadResponse.ok
            ) {

                throw new Error(
                    "Failed to upload source."
                );

            }


            /* -------------------------
               START BUILD
            ------------------------- */

            const buildResponse =
                await fetch(
                    `https://api.heroku.com/apps/${encodeURIComponent(
                        herokuApp.name
                    )}/builds`,
                    {
                        method: "POST",

                        headers: {
                            "Authorization":
                                `Bearer ${process.env.HEROKU_API_KEY}`,

                            "Accept":
                                "application/vnd.heroku+json; version=3",

                            "Content-Type":
                                "application/json"
                        },

                        body:
                            JSON.stringify({
                                source_blob: {
                                    url:
                                        source
                                            .source_blob
                                            .get_url,

                                    version:
                                        crypto.randomUUID()
                                }
                            })
                    }
                );


            let build =
                await buildResponse.json();


            if (
                !buildResponse.ok
            ) {

                throw new Error(
                    build.message ||
                    "Could not start build."
                );

            }


            console.log(
                "Build started:",
                build.id
            );


            /* -------------------------
               WAIT FOR BUILD
            ------------------------- */

            let status =
                build.status;


            for (
                let i = 0;
                i < 60;
                i++
            ) {

                if (
                    status ===
                    "succeeded"
                ) {
                    break;
                }

                if (
                    status ===
                    "failed"
                ) {
                    break;
                }


                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            3000
                        )
                );


                const checkResponse =
                    await fetch(
                        `https://api.heroku.com/apps/${encodeURIComponent(
                            herokuApp.name
                        )}/builds/${build.id}`,
                        {
                            headers: {
                                "Authorization":
                                    `Bearer ${process.env.HEROKU_API_KEY}`,

                                "Accept":
                                    "application/vnd.heroku+json; version=3"
                            }
                        }
                    );


                build =
                    await checkResponse.json();

                status =
                    build.status;


                console.log(
                    "Build:",
                    status
                );

            }


            if (
                status !==
                "succeeded"
            ) {

                throw new Error(
                    "Build failed: " +
                    status
                );

            }


            /* -------------------------
               START WORKER
            ------------------------- */

            const formationResponse =
                await fetch(
                    `https://api.heroku.com/apps/${encodeURIComponent(
                        herokuApp.name
                    )}/formation`,
                    {
                        method: "PATCH",

                        headers: {
                            "Authorization":
                                `Bearer ${process.env.HEROKU_API_KEY}`,

                            "Accept":
                                "application/vnd.heroku+json; version=3",

                            "Content-Type":
                                "application/json"
                        },

                        body:
                            JSON.stringify([
                                {
                                    type: "worker",
                                    quantity: 1,
                                    size: "eco"
                                }
                            ])
                    }
                );


            const formation =
                await formationResponse.json();


            if (
                !formationResponse.ok
            ) {

                throw new Error(
                    formation.message ||
                    "Could not start worker."
                );

            }


            /* -------------------------
               SUCCESS
            ------------------------- */

            res.json({

                success: true,

                message:
                    "Repository deployed successfully.",

                app:
                    herokuApp.name,

                app_url:
                    herokuApp.web_url,

                runtime:
                    detectedRuntime,

                build:
                    build.id,

                status:
                    "succeeded",

                worker:
                    "active"

            });


            /* -------------------------
               CLEANUP
            ------------------------- */

            try {

                if (
                    fs.existsSync(
                        tarFile
                    )
                ) {

                    fs.unlinkSync(
                        tarFile
                    );

                }

            } catch {}

        } catch (error) {

            console.error(
                "DEPLOY ERROR:",
                error
            );


            res.status(500).json({

                success: false,

                error:
                    error.message

            });

        } finally {

            try {

                if (
                    repoDirectory &&
                    fs.existsSync(
                        repoDirectory
                    )
                ) {

                    fs.rmSync(
                        repoDirectory,
                        {
                            recursive: true,
                            force: true
                        }
                    );

                }

            } catch {}

        }

    }
);


/* =========================
   RESTART
========================= */

app.post(
    "/api/apps/:name/restart",
    async (req, res) => {

        try {

            await restartApp(
                req.params.name
            );

            res.json({
                success: true,
                message:
                    "Bot restarted successfully."
            });

        } catch (error) {

            res.status(500).json({
                success: false,
                error:
                    error.message
            });

        }

    }
);


/* =========================
   DELETE
========================= */

app.delete(
    "/api/apps/:name",
    async (req, res) => {

        try {

            await deleteApp(
                req.params.name
            );

            res.json({
                success: true,
                message:
                    "Bot deleted successfully."
            });

        } catch (error) {

            res.status(500).json({
                success: false,
                error:
                    error.message
            });

        }

    }
);


/* =========================
   START SERVER
========================= */

app.listen(
    PORT,
    () => {

        console.log("");
        console.log(
            "================================"
        );
        console.log(
            "          MINI HEROKU"
        );
        console.log(
            "================================"
        );
        console.log(
            `Server: http://localhost:${PORT}`
        );

        console.log(
            "Heroku API:",
            process.env.HEROKU_API_KEY
                ? "CONNECTED"
                : "NOT CONFIGURED"
        );

        console.log(
            "Heroku Team:",
            process.env.HEROKU_TEAM ||
            "NOT CONFIGURED"
        );

        console.log(
            "================================"
        );
        console.log("");

    }
);