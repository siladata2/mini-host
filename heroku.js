import "dotenv/config";

const HEROKU_API = "https://api.heroku.com";

function headers(extra = {}) {
    return {
        Authorization: `Bearer ${process.env.HEROKU_API_KEY}`,
        Accept: "application/vnd.heroku+json; version=3",
        "Content-Type": "application/json",
        ...extra
    };
}

export async function herokuRequest(
    endpoint,
    options = {}
) {
    if (!process.env.HEROKU_API_KEY) {
        throw new Error(
            "HEROKU_API_KEY haijawekwa."
        );
    }

    const response = await fetch(
        `${HEROKU_API}${endpoint}`,
        {
            ...options,
            headers: headers(
                options.headers || {}
            )
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


/* =========================
   ACCOUNT
========================= */

export async function getAccount() {
    return await herokuRequest(
        "/account"
    );
}


/* =========================
   TEAMS
========================= */

export async function getTeams() {
    return await herokuRequest(
        "/teams"
    );
}


/* =========================
   TEAM
========================= */

export async function getTeam() {
    if (!process.env.HEROKU_TEAM) {
        throw new Error(
            "HEROKU_TEAM haijawekwa."
        );
    }

    return await herokuRequest(
        `/teams/${encodeURIComponent(
            process.env.HEROKU_TEAM
        )}`
    );
}


/* =========================
   CREATE TEAM APP
========================= */

export async function createApp(
    name
) {
    if (!process.env.HEROKU_TEAM) {
        throw new Error(
            "HEROKU_TEAM haijawekwa."
        );
    }

    return await herokuRequest(
        "/teams/apps",
        {
            method: "POST",

            body: JSON.stringify({
                name,
                team:
                    process.env.HEROKU_TEAM,
                region: "us"
            })
        }
    );
}


/* =========================
   GET TEAM APPS
========================= */

export async function getApps() {
    if (process.env.HEROKU_TEAM) {
        return await herokuRequest(
            `/teams/${encodeURIComponent(
                process.env.HEROKU_TEAM
            )}/apps`
        );
    }

    return await herokuRequest(
        "/apps"
    );
}


/* =========================
   GET APP
========================= */

export async function getApp(
    name
) {
    return await herokuRequest(
        `/apps/${encodeURIComponent(
            name
        )}`
    );
}


/* =========================
   DELETE APP
========================= */

export async function deleteApp(
    name
) {
    return await herokuRequest(
        `/apps/${encodeURIComponent(
            name
        )}`,
        {
            method: "DELETE"
        }
    );
}


/* =========================
   RESTART APP
========================= */

export async function restartApp(
    name
) {
    return await herokuRequest(
        `/apps/${encodeURIComponent(
            name
        )}/dynos`,
        {
            method: "DELETE"
        }
    );
}


/* =========================
   CONFIG VARS
========================= */

export async function setConfigVars(
    name,
    vars
) {
    return await herokuRequest(
        `/apps/${encodeURIComponent(
            name
        )}/config-vars`,
        {
            method: "PATCH",
            body: JSON.stringify(vars)
        }
    );
}


/* =========================
   GET CONFIG VARS
========================= */

export async function getConfigVars(
    name
) {
    return await herokuRequest(
        `/apps/${encodeURIComponent(
            name
        )}/config-vars`
    );
}


/* =========================
   CREATE SOURCE
========================= */

export async function createSource() {
    return await herokuRequest(
        "/sources",
        {
            method: "POST",
            body: JSON.stringify({})
        }
    );
}


/* =========================
   CREATE BUILD
========================= */

export async function createBuild(
    appName,
    sourceUrl,
    version,
    buildpacks = []
) {
    const body = {
        source_blob: {
            url: sourceUrl,
            version
        }
    };

    if (
        Array.isArray(buildpacks) &&
        buildpacks.length
    ) {
        body.buildpacks =
            buildpacks.map(item => {
                if (
                    typeof item ===
                    "string"
                ) {
                    return {
                        url: item
                    };
                }

                return item;
            });
    }

    return await herokuRequest(
        `/apps/${encodeURIComponent(
            appName
        )}/builds`,
        {
            method: "POST",
            body: JSON.stringify(body)
        }
    );
}


/* =========================
   GET BUILD
========================= */

export async function getBuild(
    appName,
    buildId
) {
    return await herokuRequest(
        `/apps/${encodeURIComponent(
            appName
        )}/builds/${encodeURIComponent(
            buildId
        )}`
    );
}


/* =========================
   FORMATION
========================= */

export async function updateFormation(
    appName,
    updates
) {
    return await herokuRequest(
        `/apps/${encodeURIComponent(
            appName
        )}/formation`,
        {
            method: "PATCH",

            body: JSON.stringify({
                updates
            })
        }
    );
}


/* =========================
   VERIFY CONNECTION
========================= */

export async function verifyHeroku() {
    try {
        const account =
            await getAccount();

        return {
            success: true,
            account
        };

    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}