import bodyParser from "body-parser";
import cors from "cors";
import express, { Request as ExpressRequest } from "express";
import forge from "node-forge";
import multer from "multer";
import {
    elizaLogger,
    generateImage,
    generateText,
    defaultCharacter,
    Media,
    getEmbeddingZeroVector,
} from "@elizaos/core";
import { composeContext } from "@elizaos/core";
import { generateMessageResponse } from "@elizaos/core";
import { messageCompletionFooter } from "@elizaos/core";
import { AgentRuntime } from "@elizaos/core";
import {
    Content,
    Memory,
    ModelClass,
    Client,
    IAgentRuntime,
} from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { settings } from "@elizaos/core";
import { TwitterClientInterface } from "@elizaos/client-twitter";
import { createApiRouter } from "./api.ts";
import * as fs from "fs";
import * as path from "path";

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
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        cb(null, `${uniqueSuffix}-${file.originalname}`);
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

const generateImagePromptInput = (
    content: string,
    style: string,
    styleDescription: string,
    detailedDescription: string
) => {
    return `You are tasked with generating an image prompt for a Twitter post based on content and a specified style.
Your goal is to create a detailed and vivid image prompt that captures the essence of the content while being optimized for Twitter engagement.

You will be given the following inputs:
<content>
${content}
</content>

<style>
${style}
</style>

<style_description>
${detailedDescription}
</style_description>

A good Twitter image prompt in ${styleDescription} style consists of the following elements:
1. Bold, attention-grabbing main subject
2. Clear, uncomplicated composition
3. Style-appropriate visual elements
4. Limited text elements (if any)
5. Visual elements that encourage sharing

To generate the Twitter-optimized image prompt, follow these steps:

1. Analyze the content text carefully, identifying key themes, emotions, and visual elements that would resonate on social media.

2. Determine the most appropriate main subject that works well in the ${styleDescription} style by:
   - Identifying concrete objects or persons that will be instantly recognizable
   - Focusing on a single clear message or concept
   - Ensuring the subject works well in both square and rectangular crops
   - Selecting elements that will stand out in a crowded feed

3. Determine a background that complements the ${styleDescription} aesthetic without overwhelming the main subject.

4. Choose lighting and color palette that is characteristic of ${styleDescription} style.

5. Identify the emotional response you want to evoke in viewers.

6. Plan a composition that works well in Twitter's image display formats.

Construct your image prompt using the following structure:
1. Main subject: Describe the primary focus that will immediately catch attention
2. Composition: Specify a layout that works well in social media formats
3. Colors: Focus on color combinations typical of ${styleDescription} style
4. Lighting: Describe lighting that creates visual interest appropriate to the style
5. Mood: Specify the emotional impact you want to create
6. Style details: Include specific ${styleDescription} style elements that enhance authenticity

Ensure that your prompt creates imagery that is instantly understandable, visually striking, and optimized for social media sharing. LIMIT the image prompt to 50 words or less.

Write a prompt. Only include the prompt and nothing else. If possible try to generate animated PNG.`;
};

// Detailed style descriptions
const styleDescriptions = {
    photorealistic: `Photorealism aims to create images indistinguishable from photographs with extreme detail and precision in all elements, accurate lighting and shadows, proper perspective, natural textures, depth of field effects, subtle imperfections for authenticity, color accuracy, and natural environmental elements. This style prioritizes technical accuracy over artistic interpretation.`,

    watercolor: `Watercolor style is characterized by its fluid, transparent quality with visible paper texture, color bleeds and gradient washes, soft edges, granulation effects, white space as an active element, layered transparency, wet-in-wet effects, slightly impressionistic details, subtle color variations, and limited use of white. The style embraces controlled unpredictability and organic flow.`,

    pixel_art: `Pixel art embraces deliberate low-resolution aesthetics with individual pixels as building blocks, limited color palettes (8-64 colors), no anti-aliasing, "jaggies" on diagonal lines, dithering patterns, consistent pixel sizing, simple iconic designs, tile-based backgrounds, and clean outlines with block shading. This style is influenced by early video games.`,

    art_deco: `Art Deco (1920s-1930s) represents luxury and progress through bold geometric shapes, symmetrical patterns, stepped forms, streamlined aerodynamic elements, high contrast colors, metallic accents, simplified elongated figures, sunburst and chevron patterns, exotic influenced motifs, and geometric sans-serif typography. It combines modernism with fine craftsmanship.`,

    cyberpunk: `Cyberpunk visualizes a high-tech dystopian future with neon lighting against dark urban environments, holographic displays, a mix of advanced technology with decay, human augmentation elements, corporate advertising, rain-slicked reflective streets, dense vertical architecture, retrofitted technology, strong color contrasts, and visible technological components.`,

    impressionist: `Impressionism focuses on capturing light and atmosphere with visible loose brushstrokes, emphasis on changing light qualities, vibrant unmixed colors placed side by side, everyday scenes, open brushwork, lack of black (shadows in color), soft edges, momentary effects over permanent reality, outdoor settings, and atmospheric perspective.`,

    vaporwave: `Vaporwave is a retrofuturistic aesthetic featuring pink and blue/teal color schemes, glitch effects, 1980s-90s computing references, classical statuary, Japanese characters, early 3D rendering, retro consumer electronics, tropical elements, Windows interface elements, and VHS quality degradation. It's deliberately nostalgic, surreal, and often ironic.`,

    isometric: `Isometric design presents 3D-like perspective without distortion using 30-degree angles, no vanishing points, consistent scale regardless of position, flat coloring with simple shadows, grid-based layout, visibility of multiple sides simultaneously, clean geometric forms, no atmospheric perspective, and often "cut-away" views of spaces.`,

    ukiyo_e: `Ukiyo-e is a traditional Japanese woodblock print style with flat areas of solid color, bold black outlines, limited but distinctive color palette, stylized natural elements, distinctive facial features, theatrical poses, asymmetrical compositions, multiple perspectives, seasonal themes, and traditional Japanese cultural elements.`,

    low_poly: `Low poly style uses minimal polygons for 3D-looking imagery with faceted surfaces, flat color within each polygon, hard edges between faces, simplified representations of complex forms, geometric approach to organic shapes, strategic light and shadow, limited color palette, clean compositions, minimal texturing, and an angular aesthetic even for rounded objects.`,
};

// Templates for each style
const imageStyleTemplates = {
    photorealistic: {
        systemPrompt: `You are an expert in writing prompts for photorealistic Twitter-optimized AI art generation. You excel at creating lifelike, highly detailed visual descriptions that work well in social media feeds. Focus on realistic lighting, textures, and compositions that communicate clearly even when viewed on small mobile screens. Your output should only contain the description of the image contents, but NOT an instruction like "create an image that..."`,

        getPromptInput: (content) =>
            generateImagePromptInput(
                content,
                "photorealistic",
                "photorealistic",
                styleDescriptions.photorealistic
            ),
    },

    watercolor: {
        systemPrompt: `You are an expert in writing prompts for watercolor-style Twitter-optimized AI art generation. You excel at creating soft, fluid, and transparent visual descriptions with characteristic watercolor aesthetics that work well in social media feeds. Focus on gentle color blending, visible paper texture, and soft edges that communicate clearly even when viewed on small mobile screens. Your output should only contain the description of the image contents, but NOT an instruction like "create an image that..."`,

        getPromptInput: (content) =>
            generateImagePromptInput(
                content,
                "watercolor",
                "watercolor",
                styleDescriptions.watercolor
            ),
    },

    pixel_art: {
        systemPrompt: `You are an expert in writing prompts for pixel art Twitter-optimized AI art generation. You excel at creating retro, low-resolution visual descriptions with limited color palettes that work well in social media feeds. Focus on blocky shapes, limited detail, and nostalgic gaming aesthetics that communicate clearly even when viewed on small mobile screens. Your output should only contain the description of the image contents, but NOT an instruction like "create an image that..."`,

        getPromptInput: (content) =>
            generateImagePromptInput(
                content,
                "pixel art",
                "pixel art",
                styleDescriptions.pixel_art
            ),
    },

    art_deco: {
        systemPrompt: `You are an expert in writing prompts for Art Deco Twitter-optimized AI art generation. You excel at creating bold, geometric, and luxurious visual descriptions with characteristic 1920s-1930s aesthetics that work well in social media feeds. Focus on symmetrical patterns, bold lines, metallic accents, and glamorous elements that communicate clearly even when viewed on small mobile screens. Your output should only contain the description of the image contents, but NOT an instruction like "create an image that..."`,

        getPromptInput: (content) =>
            generateImagePromptInput(
                content,
                "art deco",
                "Art Deco",
                styleDescriptions.art_deco
            ),
    },

    cyberpunk: {
        systemPrompt: `You are an expert in writing prompts for cyberpunk Twitter-optimized AI art generation. You excel at creating high-tech, dystopian, neon-lit visual descriptions with futuristic urban aesthetics that work well in social media feeds. Focus on holographic elements, cyber enhancements, rain-slicked streets, and stark contrasts that communicate clearly even when viewed on small mobile screens. Your output should only contain the description of the image contents, but NOT an instruction like "create an image that..."`,

        getPromptInput: (content) =>
            generateImagePromptInput(
                content,
                "cyberpunk",
                "cyberpunk",
                styleDescriptions.cyberpunk
            ),
    },

    impressionist: {
        systemPrompt: `You are an expert in writing prompts for impressionist Twitter-optimized AI art generation. You excel at creating light-filled, brushstroke-focused visual descriptions that capture moments and atmospheres in the style of Monet, Renoir, and Degas, which work well in social media feeds. Focus on visible brushwork, color vibrance, outdoor scenes, and light effects that communicate clearly even when viewed on small mobile screens. Your output should only contain the description of the image contents, but NOT an instruction like "create an image that..."`,

        getPromptInput: (content) =>
            generateImagePromptInput(
                content,
                "impressionist",
                "impressionist",
                styleDescriptions.impressionist
            ),
    },

    vaporwave: {
        systemPrompt: `You are an expert in writing prompts for vaporwave Twitter-optimized AI art generation. You excel at creating retro-futuristic, 80s/90s-inspired visual descriptions with neon aesthetics and nostalgic digital elements that work well in social media feeds. Focus on glitch effects, pink and blue color schemes, retro computer graphics, and surreal compositions that communicate clearly even when viewed on small mobile screens. Your output should only contain the description of the image contents, but NOT an instruction like "create an image that..."`,

        getPromptInput: (content) =>
            generateImagePromptInput(
                content,
                "vaporwave",
                "vaporwave",
                styleDescriptions.vaporwave
            ),
    },

    isometric: {
        systemPrompt: `You are an expert in writing prompts for isometric Twitter-optimized AI art generation. You excel at creating 3D-like visual descriptions with a specific 30-degree angle perspective and no vanishing points that work well in social media feeds. Focus on architectural elements, gaming-inspired scenes, and clean geometric compositions that communicate clearly even when viewed on small mobile screens. Your output should only contain the description of the image contents, but NOT an instruction like "create an image that..."`,

        getPromptInput: (content) =>
            generateImagePromptInput(
                content,
                "isometric",
                "isometric",
                styleDescriptions.isometric
            ),
    },

    ukiyo_e: {
        systemPrompt: `You are an expert in writing prompts for Ukiyo-e Twitter-optimized AI art generation. You excel at creating Japanese woodblock print-style visual descriptions with flat perspectives, bold outlines, and traditional Japanese aesthetics that work well in social media feeds. Focus on nature elements, figures in traditional clothing, and iconic compositions inspired by artists like Hokusai and Hiroshige that communicate clearly even when viewed on small mobile screens. Your output should only contain the description of the image contents, but NOT an instruction like "create an image that..."`,

        getPromptInput: (content) =>
            generateImagePromptInput(
                content,
                "ukiyo-e",
                "Ukiyo-e",
                styleDescriptions.ukiyo_e
            ),
    },

    low_poly: {
        systemPrompt: `You are an expert in writing prompts for low poly Twitter-optimized AI art generation. You excel at creating modern, geometric visual descriptions with faceted surfaces and a distinctive 3D rendered look that work well in social media feeds. Focus on angular shapes, simplified forms, and clean compositions with limited detail that communicate clearly even when viewed on small mobile screens. Your output should only contain the description of the image contents, but NOT an instruction like "create an image that..."`,

        getPromptInput: (content) =>
            generateImagePromptInput(
                content,
                "low poly",
                "low poly",
                styleDescriptions.low_poly
            ),
    },
};

export const messageHandlerTemplate =
    // {{goals}}
    `# Action Examples
{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Knowledge
{{knowledge}}

# Task: Generate dialog and actions for the character {{agentName}}.
About {{agentName}}:
{{bio}}
{{lore}}

{{providers}}

{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{messageDirections}}

{{recentMessages}}

{{actions}}

# Instructions: Write the next message for {{agentName}}.
` + messageCompletionFooter;

export class DirectClient {
    public app: express.Application;
    private agents: Map<string, AgentRuntime>; // container management
    private server: any; // Store server instance
    public startAgent: Function; // Store startAgent functor
    public db: any;

    constructor() {
        elizaLogger.log("DirectClient constructor");
        this.app = express();
        this.app.use(cors());
        this.agents = new Map();

        this.app.use(bodyParser.json());
        this.app.use(bodyParser.urlencoded({ extended: true }));
        // Serve both uploads and generated images
        this.app.use(
            "/media/uploads",
            express.static(path.join(process.cwd(), "/data/uploads"))
        );
        this.app.use(
            "/media/generated",
            express.static(path.join(process.cwd(), "/generatedImages"))
        );

        const apiRouter = createApiRouter(this.agents, this);
        this.app.use(apiRouter);

        // Define an interface that extends the Express Request interface
        interface CustomRequest extends ExpressRequest {
            file?: Express.Multer.File;
        }

        // Update the route handler to use CustomRequest instead of express.Request
        this.app.post(
            "/:agentId/whisper",
            upload.single("file"),
            async (req: CustomRequest, res: express.Response) => {
                const audioFile = req.file; // Access the uploaded file using req.file
                const agentId = req.params.agentId;

                if (!audioFile) {
                    res.status(400).send("No audio file provided");
                    return;
                }

                let runtime = this.agents.get(agentId);

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                const formData = new FormData();
                const audioBlob = new Blob([audioFile.buffer], {
                    type: audioFile.mimetype,
                });
                formData.append("file", audioBlob, audioFile.originalname);
                formData.append("model", "whisper-1");

                const response = await fetch(
                    "https://api.openai.com/v1/audio/transcriptions",
                    {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${runtime.token}`,
                        },
                        body: formData,
                    }
                );

                const data = await response.json();
                res.json(data);
            }
        );

        this.app.post(
            "/:agentId/message",
            upload.single("file"),
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                const roomId = stringToUuid(
                    req.body.roomId ?? "default-room-" + agentId
                );
                const userId = stringToUuid(req.body.userId ?? "user");

                let runtime = this.agents.get(agentId);

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                await runtime.ensureConnection(
                    userId,
                    roomId,
                    req.body.userName,
                    req.body.name,
                    "direct"
                );

                const text = req.body.text;
                const messageId = stringToUuid(Date.now().toString());

                const attachments: Media[] = [];
                if (req.file) {
                    const filePath = path.join(
                        process.cwd(),
                        "agent",
                        "data",
                        "uploads",
                        req.file.filename
                    );
                    attachments.push({
                        id: Date.now().toString(),
                        url: filePath,
                        title: req.file.originalname,
                        source: "direct",
                        description: `Uploaded file: ${req.file.originalname}`,
                        text: "",
                        contentType: req.file.mimetype,
                    });
                }

                const content: Content = {
                    text,
                    attachments,
                    source: "direct",
                    inReplyTo: undefined,
                };

                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };

                const memory: Memory = {
                    id: stringToUuid(messageId + "-" + userId),
                    ...userMessage,
                    agentId: runtime.agentId,
                    userId,
                    roomId,
                    content,
                    createdAt: Date.now(),
                };

                await runtime.messageManager.addEmbeddingToMemory(memory);
                await runtime.messageManager.createMemory(memory);

                let state = await runtime.composeState(userMessage, {
                    agentName: runtime.character.name,
                });

                const context = composeContext({
                    state,
                    template: messageHandlerTemplate,
                });

                const response = await generateMessageResponse({
                    runtime: runtime,
                    context,
                    modelClass: ModelClass.LARGE,
                });

                if (!response) {
                    res.status(500).send(
                        "No response from generateMessageResponse"
                    );
                    return;
                }

                // save response to memory
                const responseMessage: Memory = {
                    id: stringToUuid(messageId + "-" + runtime.agentId),
                    ...userMessage,
                    userId: runtime.agentId,
                    content: response,
                    embedding: getEmbeddingZeroVector(),
                    createdAt: Date.now(),
                };

                await runtime.messageManager.createMemory(responseMessage);

                state = await runtime.updateRecentMessageState(state);

                let message = null as Content | null;

                await runtime.processActions(
                    memory,
                    [responseMessage],
                    state,
                    async (newMessages) => {
                        message = newMessages;
                        return [memory];
                    }
                );

                await runtime.evaluate(memory, state);

                // Check if we should suppress the initial message
                const action = runtime.actions.find(
                    (a) => a.name === response.action
                );
                const shouldSuppressInitialMessage =
                    action?.suppressInitialMessage;

                if (!shouldSuppressInitialMessage) {
                    if (message) {
                        res.json([response, message]);
                    } else {
                        res.json([response]);
                    }
                } else {
                    if (message) {
                        res.json([message]);
                    } else {
                        res.json([]);
                    }
                }
            }
        );

        this.app.post(
            "/:agentId/image",
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                const agent = this.agents.get(agentId);
                if (!agent) {
                    res.status(404).send("Agent not found");
                    return;
                }
                const description = req.body.description;
                const logoPrompt = description;

                const images = await generateImage(
                    {
                        prompt: logoPrompt,
                        width: 512,
                        height: 512,
                        count: 1,
                    },
                    agent
                );

                res.json({ images });
            }
        );

        this.app.post(
            "/:agentId/twitter-post-image",
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                const postId = req.body.postId;
                const planId = req.body.planId;
                const agent = this.agents.get(agentId);
                const imageStyle = req.body.style;
                const extractedStyle = imageStyleTemplates[imageStyle];
                if (!agent) {
                    res.status(404).send("Agent not found");
                    return;
                }

                const CONTENT = req.body.description;
                const IMAGE_SYSTEM_PROMPT = extractedStyle.systemPrompt;

                const IMAGE_PROMPT_INPUT =
                    extractedStyle.getPromptInput(CONTENT);
                const imagePrompt = await generateText({
                    runtime: agent,
                    context: IMAGE_PROMPT_INPUT,
                    modelClass: ModelClass.MEDIUM,
                    customSystemPrompt: IMAGE_SYSTEM_PROMPT,
                });

                const images = await generateImage(
                    {
                        prompt: imagePrompt,
                        width: 1280,
                        height: 704,
                        count: 1,
                    },
                    agent
                );
                if (images.success && images.data && images.data.length > 0) {
                    elizaLogger.log(
                        "Image generation successful, number of images:",
                        images.data.length
                    );
                    const image = images.data[0];

                    // Save the image and get filepath
                    const filename = `${planId}_${postId}_${Date.now()}`;

                    // Choose save function based on image data format
                    const filepath = saveBase64Image(image, filename);

                    res.json({ filepath });
                } else {
                    res.json({
                        error: "Image generation failed or returned no data.",
                    });
                    elizaLogger.error(
                        "Image generation failed or returned no data."
                    );
                }
            }
        );

        this.app.post(
            "/fine-tune",
            async (req: express.Request, res: express.Response) => {
                try {
                    const response = await fetch(
                        "https://api.bageldb.ai/api/v1/asset",
                        {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "X-API-KEY": `${process.env.BAGEL_API_KEY}`,
                            },
                            body: JSON.stringify(req.body),
                        }
                    );

                    const data = await response.json();
                    res.json(data);
                } catch (error) {
                    res.status(500).json({
                        error: "Please create an account at bakery.bagel.net and get an API key. Then set the BAGEL_API_KEY environment variable.",
                        details: error.message,
                    });
                }
            }
        );
        this.app.get(
            "/fine-tune/:assetId",
            async (req: express.Request, res: express.Response) => {
                const assetId = req.params.assetId;
                const downloadDir = path.join(
                    process.cwd(),
                    "downloads",
                    assetId
                );

                console.log("Download directory:", downloadDir);

                try {
                    console.log("Creating directory...");
                    await fs.promises.mkdir(downloadDir, { recursive: true });

                    console.log("Fetching file...");
                    const fileResponse = await fetch(
                        `https://api.bageldb.ai/api/v1/asset/${assetId}/download`,
                        {
                            headers: {
                                "X-API-KEY": `${process.env.BAGEL_API_KEY}`,
                            },
                        }
                    );

                    if (!fileResponse.ok) {
                        throw new Error(
                            `API responded with status ${fileResponse.status}: ${await fileResponse.text()}`
                        );
                    }

                    console.log("Response headers:", fileResponse.headers);

                    const fileName =
                        fileResponse.headers
                            .get("content-disposition")
                            ?.split("filename=")[1]
                            ?.replace(/"/g, /* " */ "") || "default_name.txt";

                    console.log("Saving as:", fileName);

                    const arrayBuffer = await fileResponse.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);

                    const filePath = path.join(downloadDir, fileName);
                    console.log("Full file path:", filePath);

                    await fs.promises.writeFile(filePath, buffer);

                    // Verify file was written
                    const stats = await fs.promises.stat(filePath);
                    console.log(
                        "File written successfully. Size:",
                        stats.size,
                        "bytes"
                    );

                    res.json({
                        success: true,
                        message: "Single file downloaded successfully",
                        downloadPath: downloadDir,
                        fileCount: 1,
                        fileName: fileName,
                        fileSize: stats.size,
                    });
                } catch (error) {
                    console.error("Detailed error:", error);
                    res.status(500).json({
                        error: "Failed to download files from BagelDB",
                        details: error.message,
                        stack: error.stack,
                    });
                }
            }
        );

        this.app.post("/:agentId/speak", async (req, res) => {
            const agentId = req.params.agentId;
            const roomId = stringToUuid(
                req.body.roomId ?? "default-room-" + agentId
            );
            const userId = stringToUuid(req.body.userId ?? "user");
            const text = req.body.text;

            if (!text) {
                res.status(400).send("No text provided");
                return;
            }

            let runtime = this.agents.get(agentId);

            // if runtime is null, look for runtime with the same name
            if (!runtime) {
                runtime = Array.from(this.agents.values()).find(
                    (a) =>
                        a.character.name.toLowerCase() === agentId.toLowerCase()
                );
            }

            if (!runtime) {
                res.status(404).send("Agent not found");
                return;
            }

            try {
                // Process message through agent (same as /message endpoint)
                await runtime.ensureConnection(
                    userId,
                    roomId,
                    req.body.userName,
                    req.body.name,
                    "direct"
                );

                const messageId = stringToUuid(Date.now().toString());

                const content: Content = {
                    text,
                    attachments: [],
                    source: "direct",
                    inReplyTo: undefined,
                };

                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };

                const memory: Memory = {
                    id: messageId,
                    agentId: runtime.agentId,
                    userId,
                    roomId,
                    content,
                    createdAt: Date.now(),
                };

                await runtime.messageManager.createMemory(memory);

                const state = await runtime.composeState(userMessage, {
                    agentName: runtime.character.name,
                });

                const context = composeContext({
                    state,
                    template: messageHandlerTemplate,
                });

                const response = await generateMessageResponse({
                    runtime: runtime,
                    context,
                    modelClass: ModelClass.LARGE,
                });

                // save response to memory
                const responseMessage = {
                    ...userMessage,
                    userId: runtime.agentId,
                    content: response,
                };

                await runtime.messageManager.createMemory(responseMessage);

                if (!response) {
                    res.status(500).send(
                        "No response from generateMessageResponse"
                    );
                    return;
                }

                await runtime.evaluate(memory, state);

                const _result = await runtime.processActions(
                    memory,
                    [responseMessage],
                    state,
                    async () => {
                        return [memory];
                    }
                );

                // Get the text to convert to speech
                const textToSpeak = response.text;

                // Convert to speech using ElevenLabs
                const elevenLabsApiUrl = `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`;
                const apiKey = process.env.ELEVENLABS_XI_API_KEY;

                if (!apiKey) {
                    throw new Error("ELEVENLABS_XI_API_KEY not configured");
                }

                const speechResponse = await fetch(elevenLabsApiUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "xi-api-key": apiKey,
                    },
                    body: JSON.stringify({
                        text: textToSpeak,
                        model_id:
                            process.env.ELEVENLABS_MODEL_ID ||
                            "eleven_multilingual_v2",
                        voice_settings: {
                            stability: parseFloat(
                                process.env.ELEVENLABS_VOICE_STABILITY || "0.5"
                            ),
                            similarity_boost: parseFloat(
                                process.env.ELEVENLABS_VOICE_SIMILARITY_BOOST ||
                                    "0.9"
                            ),
                            style: parseFloat(
                                process.env.ELEVENLABS_VOICE_STYLE || "0.66"
                            ),
                            use_speaker_boost:
                                process.env
                                    .ELEVENLABS_VOICE_USE_SPEAKER_BOOST ===
                                "true",
                        },
                    }),
                });

                if (!speechResponse.ok) {
                    throw new Error(
                        `ElevenLabs API error: ${speechResponse.statusText}`
                    );
                }

                const audioBuffer = await speechResponse.arrayBuffer();

                // Set appropriate headers for audio streaming
                res.set({
                    "Content-Type": "audio/mpeg",
                    "Transfer-Encoding": "chunked",
                });

                res.send(Buffer.from(audioBuffer));
            } catch (error) {
                console.error(
                    "Error processing message or generating speech:",
                    error
                );
                res.status(500).json({
                    error: "Error processing message or generating speech",
                    details: error.message,
                });
            }
        });
        this.app.post(
            "/start-twitter-agent",
            async (req: express.Request, res: express.Response) => {
                const username = req.body.username;
                const tokenAddress = req.body.tokenAddress;
                const ideaName = req.body.ideaName;

                // OAuth credentials
                const accessToken = req.body.accessToken;
                const accessSecret = req.body.accessSecret;
                const oauthVerifier = req.body.oauthVerifier;
                const appKey = process.env.TWITTER_API_KEY;
                const appSecret = process.env.TWITTER_API_SECRET_KEY;
                const agentId = stringToUuid("new-agent-" + tokenAddress);
                const dynamicCharacter = req.body.character;
                let messageExamples = [];
                if (dynamicCharacter?.messageExamples?.length) {
                    messageExamples = dynamicCharacter.messageExamples.map(
                        (example) => {
                            return example.map((e, index) => {
                                return {
                                    user: index === 0 ? "{{user1}}" : ideaName,
                                    content: {
                                        text: e.content.text,
                                    },
                                };
                            });
                        }
                    );
                }
                let runtime: AgentRuntime = await this.startAgent({
                    ...defaultCharacter,
                    name: ideaName,
                    twitterQuery: dynamicCharacter
                        ? dynamicCharacter.twitterQuery.join(" ")
                        : "",
                    id: agentId,
                    username,
                    settings: {
                        secrets: {
                            TWITTER_USERNAME: username,
                            TWITTER_ACCESS_TOKEN: accessToken,
                            TWITTER_ACCESS_TOKEN_SECRET: accessSecret,
                            TWITTER_AUTH_VERIFIER: oauthVerifier,
                        },
                    },
                    system: dynamicCharacter?.system || defaultCharacter.system,
                    bio: dynamicCharacter?.bio || defaultCharacter.bio,
                    lore: dynamicCharacter?.lore || defaultCharacter.lore,
                    messageExamples: dynamicCharacter
                        ? messageExamples
                        : defaultCharacter.messageExamples,
                    postExamples:
                        dynamicCharacter?.postExamples ||
                        defaultCharacter.postExamples,
                    topics: dynamicCharacter?.topics || defaultCharacter.topics,
                    style: dynamicCharacter?.style || defaultCharacter.style,
                    adjectives:
                        dynamicCharacter?.adjectives ||
                        defaultCharacter.adjectives,
                });

                this.agents.set(runtime.agentId, runtime);

                const roomId = stringToUuid(
                    req.body.roomId ?? "default-room-" + agentId
                );
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                await runtime.ensureConnection(
                    agentId,
                    roomId,
                    req.body.userName,
                    req.body.name,
                    "direct"
                );
                try {
                    await TwitterClientInterface.stop(runtime);
                    const { loginSuccess, manager: twitterClient }: any =
                        await TwitterClientInterface.startExternal(
                            runtime,
                            username,
                            appKey,
                            appSecret,
                            accessToken,
                            accessSecret,
                            oauthVerifier
                        );

                    if (twitterClient && loginSuccess) {
                        runtime.clients.twitter = twitterClient;
                        res.status(200).json({
                            success: true,
                            agentId: runtime.agentId,
                        });
                    }
                    if (!loginSuccess) {
                        this.unregisterAgent(this.agents.get(agentId));
                        res.status(403).json({
                            success: false,
                            message:
                                "Failed to start client. Check your credentials.",
                        });
                    }
                } catch (error) {
                    console.log(error);
                    this.unregisterAgent(this.agents.get(agentId));
                    res.status(403).json({
                        success: false,
                        message:
                            "Failed to start client. Check your credentials.",
                    });
                }
            }
        );

        this.app.post(
            "/stop-twitter/:agentId",
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                try {
                    const runtime: AgentRuntime = this.agents.get(agentId);
                    await TwitterClientInterface.stop(runtime);
                    this.unregisterAgent(this.agents.get(agentId));
                    const rooms = await this.db.getRooms();
                    const room = rooms.find((r: any) => r.id === agentId);
                    this.db.updateRoomStatus(
                        agentId,
                        "stopped",
                        room.character,
                        room.settings
                    );
                    res.status(200).json({ success: true });
                } catch (error) {
                    console.log(error);
                    res.status(400).json({ success: false });
                }
            }
        );
    }

    private decryptPassword(encryptedPassword) {
        try {
            const publicKey = process.env.PASSWORD_PUBLIC_KEY || "";
            const encrypted = forge.util.decode64(encryptedPassword);
            const privateKey = forge.pki.privateKeyFromPem(publicKey);
            const decrypted = privateKey.decrypt(encrypted, "RSA-OAEP", {
                md: forge.md.sha256.create(),
                mgf1: {
                    md: forge.md.sha256.create(),
                },
            });

            return decrypted;
        } catch (error) {
            console.error("Decryption failed:", error);
            throw new Error("Failed to decrypt password");
        }
    }
    // agent/src/index.ts:startAgent calls this
    public registerAgent(runtime: AgentRuntime) {
        this.agents.set(runtime.agentId, runtime);
    }

    public unregisterAgent(runtime: AgentRuntime) {
        this.agents.delete(runtime.agentId);
    }

    public start(port: number) {
        this.server = this.app.listen(port, () => {
            elizaLogger.success(
                `REST API bound to 0.0.0.0:${port}. If running locally, access it at http://localhost:${port}.`
            );
        });

        // Handle graceful shutdown
        const gracefulShutdown = () => {
            elizaLogger.log("Received shutdown signal, closing server...");
            this.server.close(() => {
                elizaLogger.success("Server closed successfully");
                process.exit(0);
            });

            // Force close after 5 seconds if server hasn't closed
            setTimeout(() => {
                elizaLogger.error(
                    "Could not close connections in time, forcefully shutting down"
                );
                process.exit(1);
            }, 5000);
        };

        // Handle different shutdown signals
        process.on("SIGTERM", gracefulShutdown);
        process.on("SIGINT", gracefulShutdown);
    }

    public stop() {
        if (this.server) {
            this.server.close(() => {
                elizaLogger.success("Server stopped");
            });
        }
    }
}

export const DirectClientInterface: Client = {
    start: async (_runtime: IAgentRuntime) => {
        elizaLogger.log("DirectClientInterface start");
        const client = new DirectClient();
        const serverPort = parseInt(settings.SERVER_PORT || "3000");
        client.start(serverPort);
        return client;
    },
    stop: async (_runtime: IAgentRuntime, client?: Client) => {
        if (client instanceof DirectClient) {
            client.stop();
        }
    },
};

export default DirectClientInterface;
