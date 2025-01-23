const { GoogleGenerativeAI } = require("@google/generative-ai");
const {GoogleAIFileManager, FileState} = require("@google/generative-ai/server");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

// Intercom Config
const INTERCOM_ACCESS_TOKEN = "dG9rOjlhYjNmN2RkXzExYzhfNDdmNl9hMjA0XzBmMWFlZGU2NmZlOToxOjA="; // Replace with your Intercom Access Token
const INTERCOM_BASE_URL = "https://api.intercom.io";

// Initialize Gemini SDK
const genAI = new GoogleGenerativeAI("AIzaSyD4_XYF5CEoA1mwLUT50r3MKazK-uBPuNY"); // Replace with your Gemini API Key
const fileManager = new GoogleAIFileManager("AIzaSyD4_XYF5CEoA1mwLUT50r3MKazK-uBPuNY");

// Axios instance for Intercom API
const intercomApi = axios.create({
  baseURL: INTERCOM_BASE_URL,
  headers: {
    Authorization: `Bearer ${INTERCOM_ACCESS_TOKEN}`,
    Accept: "application/json",
  },
});

async function fetchConversation(conversationId) {
  try {
    const response = await intercomApi.get(`/conversations/${conversationId}`);
    console.log("Full Conversation Data:", response.data); // Log full data to debug

    // Extract title and description from custom_attributes
    const customAttributes = response.data.custom_attributes || {};
    const title = customAttributes._default_title_ || "No title provided";
    const description = customAttributes._default_description_ || "No description provided";

    console.log(`Ticket Title: ${title}`);
    console.log(`Ticket Description: ${description}`);

    return { conversation: response.data, title, description };
  } catch (error) {
    console.error(`Failed to fetch conversation: ${error.response?.status || error.message}`);
    return null;
  }
}

// Upload video to Gemini and wait for processing
async function uploadToGeminiAndProcess(filePath) {
  console.log(`Uploading ${filePath} to Gemini...`);
  try {
    const uploadResponse = await fileManager.uploadFile(filePath, {
      mimeType: "video/mp4", // Adjust MIME type as necessary
      displayName: path.basename(filePath),
    });

    console.log("Upload complete. File URI:", uploadResponse.file.uri);

    // Poll for the file's processing status
    let file = await fileManager.getFile(uploadResponse.file.name);
    while (file.state === FileState.PROCESSING) {
      console.log("File is still processing...");
      await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
      file = await fileManager.getFile(uploadResponse.file.name);
    }

    if (file.state === FileState.FAILED) {
      throw new Error("Video processing failed.");
    }

    console.log("File is ACTIVE and ready for inference.");
    return file.uri;
  } catch (error) {
    console.error(`Failed to upload or process video: ${error.message}`);
    return null;
  }
}

// Perform inference with Gemini, including title and description
async function performInference(fileUri, title, description, promptTemplate) {
  console.log("Performing inference with Gemini...");
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

  // Prepare the final prompt with ticket title and description
  const prompt = `
    Ticket Title: ${title}
    Ticket Description: ${description}
    ${promptTemplate}
  `;

  try {
    const response = await model.generateContent([
      {
        fileData: {
          mimeType: "video/mp4",
          fileUri: fileUri,
        },
      },
      { text: prompt },
    ]);

    return response.response.text();
  } catch (error) {
    console.error(`Failed to perform inference: ${error.message}`);
    return null;
  }
}

// Download the latest attachment, upload to Gemini, and perform inference
async function downloadAndAnalyzeAttachment(conversationId) {
  const conversationData = await fetchConversation(conversationId);

  if (!conversationData) {
    console.log("Failed to retrieve conversation data.");
    return;
  }

  const { conversation, title, description } = conversationData;
  const conversationParts = conversation?.conversation_parts?.conversation_parts || [];

  for (let i = conversationParts.length - 1; i >= 0; i--) {
    const part = conversationParts[i];
    const attachments = part.attachments || [];
    if (attachments.length > 0) {
      const latestAttachment = attachments[0];

      // Safely handle file_name and ensure extension
      let fileName = latestAttachment.file_name || `attachment-${Date.now()}`;
      fileName = path.extname(fileName) ? fileName : `${fileName}.mp4`;
      const attachmentUrl = latestAttachment.url;

      console.log(`Downloading ${fileName} from ${attachmentUrl}...`);
      try {
        const fileResponse = await axios.get(attachmentUrl, { responseType: "stream" });
        const writer = fs.createWriteStream(fileName);

        await new Promise((resolve, reject) => {
          fileResponse.data.pipe(writer);
          writer.on("finish", resolve);
          writer.on("error", reject);
        });

        console.log(`Attachment ${fileName} downloaded successfully!`);

        // Upload to Gemini
        const fileUri = await uploadToGeminiAndProcess(fileName);

        if (fileUri) {
          // Perform inference with enhanced context
          const promptTemplate = `
            Analyze this video thoroughly within the context of FlutterFlow and FlutterFlow Test Mode. 

            Provide a detailed breakdown of the following:
            1. Describe the sequence of actions performed in the video step-by-step, mentioning every interaction, input, and observable event.
            2. Identify any errors, bugs, or unexpected behaviors shown in the video. Include potential causes of these issues based on the actions performed.
            3. Highlight any performance issues, such as delays, crashes, or unusual visual behavior.
            4. Contextualize all observations with respect to FlutterFlow features, such as widget interactions, UI updates, or backend integrations.
            5. If the video shows Test Mode, describe any inconsistencies or unusual responses that deviate from expected FlutterFlow Test Mode behavior.
            6. Provide time-stamped annotations for every key observation (e.g., [00:35]: Error message observed when submitting the form).
            7. Include any inferred developer intent based on user actions and explain how those intentions align or conflict with expected FlutterFlow behavior.

            Format the analysis in a structured, step-by-step manner, and ensure it includes enough descriptive detail for another AI agent to independently interpret the video and provide solutions.
          `;

          const inferenceResult = await performInference(fileUri, title, description, promptTemplate);
          console.log("Inference Result:", inferenceResult);
        }

        return;
      } catch (downloadError) {
        console.error(`Failed to download attachment: ${downloadError.message}`);
        return;
      }
    }
  }
  console.log("No attachments found in the conversation.");
}

// Example usage
(async () => {
  const conversationId = "5"; // Replace with the actual conversation ID
  await downloadAndAnalyzeAttachment(conversationId);
})();