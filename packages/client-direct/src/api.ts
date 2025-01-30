import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import {
    AgentRuntime,
    elizaLogger,
    getEnvVariable,
    validateCharacterConfig,
} from "@elizaos/core";
import { generateImage } from "plugin-image-generation";
import { REST, Routes } from "discord.js";
import { DirectClient } from ".";

const checkOrigin = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    const origin = req.get("origin");
    const host = req.get("host");

    const isLocalhost =
        origin === "http://localhost:3000" || host === "localhost:8000";
    const isDreamstarter =
        origin?.endsWith("dreamstarter.xyz") ||
        origin?.endsWith("dreamstarter.vercel.app");

    if (isLocalhost || isDreamstarter) {
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
                twitterQuery: agent?.character?.twitterQuery.split(" ") || [],
            },
            twitter: {
                processionActions:
                    twitterClient?.post?.enableActionProcessing || false,
                schedulingPosts:
                    twitterClient?.post?.enableScheduledPosts || false,
                followProfiles: twitterClient?.search?.enableFollow || false,
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

   router.post("/generate-image", async (req, res) => {
       const { description } = req.body;

       if (
           !description ||
           typeof description !== "string" ||
           description.trim() === ""
       ) {
           return res.status(400).json({
               success: false,
               message:
                   "Description is required and must be a non-empty string.",
           });
       }

       try {
           const image = await generateImage(description);

           res.json({ success: true, image });
       } catch (error) {
           console.error("Error generating image:", error);
           res.status(500).json({
               success: false,
               error: "Failed to generate image.",
               details: error.message || "Internal server error",
           });
       }
   });

    router.post("/agents/:agentId/set", async (req, res) => {
        const agentId = req.params.agentId;
        const schedulingPosts = req.body.schedulingPosts;
        const followProfiles = req.body.followProfiles;
        const processionActions = req.body.processionActions;

        const agent: AgentRuntime = agents.get(agentId);

        const twitterManager = agent.clients["twitter"];

        // load character from body
        const character = req.body.character;
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
            if (twitterManager.search.enableFollow !== followProfiles) {
                twitterManager.search.enableFollow = followProfiles;
                await twitterManager.search[
                    followProfiles ? "start" : "stop"
                ]();
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
