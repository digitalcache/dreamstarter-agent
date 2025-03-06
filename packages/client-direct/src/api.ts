import express, { Request as ExpressRequest } from "express";
import bodyParser from "body-parser";
import cors from "cors";
import multer from "multer";
import * as fs from "fs";
import * as path from "path";
import {
    AgentRuntime,
    elizaLogger,
    getEnvVariable,
    validateCharacterConfig,
} from "@elizaos/core";

import { REST, Routes } from "discord.js";
import { DirectClient } from ".";
interface CustomRequest extends ExpressRequest {
    image?: Express.Multer.File;
}
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(process.cwd(), "data", "uploads");
        // Create the directory if it doesn't exist
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `upload_${Date.now()}`);
    },
});

const upload = multer({ storage });

export function saveBase64Image(base64Data: string, filename: string): string {
    const imageDir = path.join(process.cwd(), "generatedImages");
    if (!fs.existsSync(imageDir)) {
        fs.mkdirSync(imageDir, { recursive: true });
    }
    const base64Image = base64Data.replace(/^data:image\/\w+;base64,/, "");
    const imageBuffer = Buffer.from(base64Image, "base64");
    const filepath = path.join(imageDir, `${filename}.png`);
    fs.writeFileSync(filepath, imageBuffer);
    return filepath;
}

const checkOrigin = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    const origin = req.get("origin");
    const host = req.get("host");

    const isLocalhost =
        origin === "http://localhost:3000" || host === "localhost:8000";
    const isFromWeb =
        origin?.endsWith("dreamstarter.xyz") ||
        origin?.endsWith("web3it.ai") ||
        origin?.endsWith("dreamstarter.vercel.app");

    if (isLocalhost || isFromWeb) {
        next();
    } else {
        res.status(403).json({
            error: "Access forbidden - Invalid origin",
        });
    }
};

export function createApiRouter(
    agents: Map<string, AgentRuntime>,
    directClient: DirectClient
) {
    const router = express.Router();

    const corsOptions = {
        origin: [
            "http://localhost:3000",
            /\.dreamstarter\.xyz$/,
            /\.web3it\.ai$/,
            /\.dreamstarter\.vercel\.app$/,
        ],
        optionsSuccessStatus: 200,
    };

    router.use(cors(corsOptions));
    router.use(bodyParser.json());
    router.use(bodyParser.urlencoded({ extended: true }));
    router.use(
        express.json({
            limit: getEnvVariable("EXPRESS_MAX_PAYLOAD") || "100kb",
        })
    );

    router.use(checkOrigin);
    router.use((req, res, next) => {
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
        next();
    });

    router.get("/", (req, res) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.send("Welcome to REST API of DreamStarter");
    });

    router.get("/agents", (req, res) => {
        elizaLogger.debug(directClient[""]);

        const agentsList = Array.from(agents.values()).map((agent) => ({
            id: agent.agentId,
            name: agent.character.name,
            clients: Object.keys(agent.clients),
        }));
        res.json({ agents: agentsList });
    });

    router.get("/agents/:agentId", async (req, res) => {
        const agentId = req.params.agentId;
        const agent = agents.get(agentId);

        if (!agent) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }
        const twitterClient = agent.clients["twitter"];
        res.json({
            id: agent.agentId,
            character: {
                ...agent.character,
                secrets: {},
                twitterQuery: agent?.character?.twitterQuery.split(" ") || [],
            },
            twitter: {
                processionActions:
                    twitterClient?.post?.enableActionProcessing || false,
                schedulingPosts:
                    twitterClient?.post?.enableScheduledPosts || false,
                followProfiles: twitterClient?.search?.enableFollow || false,
                postInterval: twitterClient?.post?.postInterval || 0,
                twitterTargetUsers:
                    twitterClient?.post?.twitterTargetUsers || "",
                actionInterval: twitterClient?.post?.actionInterval || 0,
                followInterval: twitterClient?.search?.followInterval || 0,
                numTweets: twitterClient?.post?.numTweets || 0,
                numLikes: twitterClient?.post?.numLikes || 0,
                numRetweets: twitterClient?.post?.numRetweets || 0,
                numFollowed: twitterClient?.search?.numFollowed || 0,
                numReplies:
                    (twitterClient?.post?.numReplies || 0) +
                    (twitterClient?.interaction?.numReplies || 0),
            },
        });
    });

    router.get("/agents/:agentId/tweets", async (req, res) => {
        const agentId = req.params.agentId;
        const agent = agents.get(agentId);

        if (!agent) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }
        const twitterClient = agent.clients["twitter"];
        if (twitterClient && twitterClient.post.currentPlanId) {
            const postManager = twitterClient.post;
            const contentManager = postManager.contentPlanManager;
            const plan = await contentManager.getPlan(
                postManager.currentPlanId
            );
            plan.posts = plan.posts.sort(
                (a, b) =>
                    new Date(a.scheduledTime).getTime() -
                    new Date(b.scheduledTime).getTime()
            );
            res.json({
                id: agent.agentId,
                plan: plan,
            });
            return;
        }
        res.status(404).json({ error: "Could not find twitter account" });
    });

    router.post("/agents/:agentId/update-tweet", async (req, res) => {
        const agentId = req.params.agentId;
        const agent = agents.get(agentId);
        const content = req.body.content;
        const postId = req.body.postId;
        const planId = req.body.planId;
        if (!agent) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }
        const twitterClient = agent.clients["twitter"];
        if (twitterClient && twitterClient.post.currentPlanId) {
            const postManager = twitterClient.post;
            const contentManager = postManager.contentPlanManager;
            await contentManager.updatePost(planId, postId, {
                content: content,
            });
            res.json({
                status: "success",
            });
            return;
        }
        res.status(404).json({
            status: "failed",
        });
    });

    router.post(
        "/agents/:agentId/update-tweet-image",
        upload.single("image"),
        async (req: CustomRequest, res: express.Response) => {
            const agentId = req.params.agentId;
            const agent = agents.get(agentId);
            const postId = req.body.postId;
            const planId = req.body.planId;
            const imageFromAI = req.body.imageFromAI;
            let filepath = imageFromAI;

            // const filepath = path.join(imageDir, `${filename}.png`);
            const baseDir = path.join(process.cwd(), "generatedImages");
            const generatedFileName = imageFromAI?.split("/").pop();
            let newPath = path.join(baseDir, `${generatedFileName}`);
            if (!agent) {
                res.status(404).json({ error: "Agent not found" });
                return;
            }
            if (!imageFromAI) {
                const newFilename = `${planId}_${postId}_${Date.now()}`;
                newPath = path.join(path.dirname(req.file.path), newFilename);
                newPath = newPath + "." + req.file.mimetype.split("/")[1];
                fs.renameSync(req.file.path, newPath);
                const normalizedPath = newPath.replace(/\\/g, "/");
                const filename = normalizedPath.split("/").pop();
                filepath = `http://localhost:8000/media/uploads/${filename}`;
            }
            const twitterClient = agent.clients["twitter"];
            if (twitterClient && twitterClient.post.currentPlanId) {
                const postManager = twitterClient.post;
                const contentManager = postManager.contentPlanManager;
                await contentManager.updatePost(planId, postId, {
                    attachments: [filepath],
                    localPath: [
                        {
                            type: imageFromAI ? "image/png" : req.file.mimetype,
                            url: newPath,
                        },
                    ],
                });
                res.json({
                    status: "success",
                });
                return;
            }
            res.status(404).json({
                status: "failed",
            });
        }
    );

    router.delete("/agents/:agentId/remove-tweet-image", async (req, res) => {
        const agentId = req.params.agentId;
        const agent = agents.get(agentId);
        const postId = req.body.postId;
        const planId = req.body.planId;

        if (!agent) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        const twitterClient = agent.clients["twitter"];

        if (twitterClient && twitterClient.post.currentPlanId) {
            const postManager = twitterClient.post;
            const contentManager = postManager.contentPlanManager;

            try {
                // Update the post with empty attachments array to remove images
                await contentManager.updatePost(planId, postId, {
                    attachments: [],
                });

                res.json({
                    status: "success",
                    message: "Image removed successfully",
                });
            } catch (error) {
                console.error("Error removing image:", error);
                res.status(500).json({
                    status: "failed",
                    error: "Failed to remove image",
                });
            }
            return;
        }

        res.status(404).json({
            status: "failed",
            error: "Twitter client or plan not found",
        });
    });

    router.post("/agents/:agentId/set", async (req, res) => {
        const agentId = req.params.agentId;
        const schedulingPosts = req.body.schedulingPosts;
        const followProfiles = req.body.followProfiles;
        const processionActions = req.body.processionActions;
        const twitterTargetUsers = req.body.twitterTargetUsers;
        const postInterval = req.body.postInterval;
        const actionInterval = req.body.actionInterval;
        const followInterval = req.body.followInterval;
        const character = req.body.character;
        const settings = {
            schedulingPosts,
            followProfiles,
            processionActions,
            postInterval,
            twitterTargetUsers,
            actionInterval,
            followInterval,
        };
        const agent: AgentRuntime = agents.get(agentId);
        const rooms = await directClient.db.getRooms();
        const room = rooms.find((room) => room.id === agentId);
        await directClient.db.updateRoomStatus(
            agent.agentId,
            "active",
            JSON.stringify({
                ...character,
                settings: JSON.parse(room.character).settings,
                twitterQuery: character.twitterQuery.join(" "),
            }),
            JSON.stringify(settings)
        );

        const twitterManager = agent.clients["twitter"];

        // load character from body

        try {
            validateCharacterConfig(character);
        } catch (e) {
            elizaLogger.error(`Error parsing character: ${e}`);
            res.status(400).json({
                success: false,
                message: e.message,
            });
            return;
        }
        agent.character = {
            ...character,
            twitterQuery: character.twitterQuery.join(" "),
        };

        if (twitterManager) {
            if (twitterManager.search.followInterval !== followInterval) {
                twitterManager.search.followInterval = followInterval;
                if (followProfiles) {
                    await twitterManager.search.stop();
                    await twitterManager.search.start();
                }
            }

            if (twitterManager.search.enableFollow !== followProfiles) {
                twitterManager.search.enableFollow = followProfiles;
                await twitterManager.search[
                    followProfiles ? "start" : "stop"
                ]();
            }

            if (twitterManager.post.actionInterval !== actionInterval) {
                twitterManager.post.actionInterval = actionInterval;
                twitterManager.interaction.twitterPollInterval =
                    actionInterval / 1000;
                if (processionActions) {
                    await twitterManager.post.stop();
                    await twitterManager.post.startProcessingActions();
                    await twitterManager.interaction.stop();
                    await twitterManager.interaction.start();
                }
            }

            if (twitterManager.post.twitterTargetUsers !== twitterTargetUsers) {
                twitterManager.post.twitterTargetUsers = twitterTargetUsers;
                if (processionActions) {
                    await twitterManager.post.stop();
                    await twitterManager.post.startProcessingActions();
                }
            }

            if (
                twitterManager.post.enableActionProcessing !== processionActions
            ) {
                twitterManager.post.enableActionProcessing = processionActions;
                await twitterManager.post[
                    processionActions ? "startProcessingActions" : "stop"
                ]();
                if (processionActions) {
                    await twitterManager.interaction.start();
                } else {
                    await twitterManager.interaction.stop();
                }
            }

            if (twitterManager.post.postInterval !== postInterval) {
                twitterManager.post.postInterval = postInterval;
                if (schedulingPosts) {
                    if (twitterManager.post.currentPlanId) {
                        const activePlan =
                            await twitterManager.post.contentPlanManager.getPlan(
                                twitterManager.post.currentPlanId
                            );
                        if (activePlan) {
                            await twitterManager.post.recalculatePostSchedule(
                                activePlan,
                                postInterval
                            );
                        }
                    }

                    await twitterManager.post.stopNewTweets();
                    await twitterManager.post.start();
                }
            }

            if (twitterManager.post.enableScheduledPosts !== schedulingPosts) {
                twitterManager.post.enableScheduledPosts = schedulingPosts;
                await twitterManager.post[
                    schedulingPosts ? "start" : "stopNewTweets"
                ]();
            }
            elizaLogger.log(`${character.name}  - new settings applied`);
        }

        res.json({
            id: character.id,
            character: character,
        });
    });

    router.get("/agents/:agentId/channels", async (req, res) => {
        const agentId = req.params.agentId;
        const runtime = agents.get(agentId);

        if (!runtime) {
            res.status(404).json({ error: "Runtime not found" });
            return;
        }

        const API_TOKEN = runtime.getSetting("DISCORD_API_TOKEN") as string;
        const rest = new REST({ version: "10" }).setToken(API_TOKEN);

        try {
            const guilds = (await rest.get(Routes.userGuilds())) as Array<any>;

            res.json({
                id: runtime.agentId,
                guilds: guilds,
                serverCount: guilds.length,
            });
        } catch (error) {
            console.error("Error fetching guilds:", error);
            res.status(500).json({ error: "Failed to fetch guilds" });
        }
    });

    return router;
}
