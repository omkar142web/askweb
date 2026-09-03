"use strict";

const CHATGPT_URL = "https://chatgpt.com/?temporary-chat=true";
const CHATGPT_LOGIN_URL = "https://chatgpt.com/auth/login";
const CONVERSATION_URL_RE = /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const AUTH_COOKIE_PREFIXES = [
    "__Secure-next-auth.session-token",
    "next-auth.session-token",
    "authjs.session-token",
];

const TITLE_SUFFIX_RE = /-\s*ChatGPT\s*$/i;

function isOnAuthPage(page) {
    const url = page.url();
    return url.includes("/auth/login") || url.includes("/auth/signin");
}

function createChatGptProvider(deps) {
    const {
        gotoChatGPT,
        waitForChatGPTReady,
        isLoggedInViaCookies,
        runLoginFlow,
        runLogoutFlow,
        promptInput,
        sendButton,
        stopButton,
        attachButton,
        fileInput,
        assistantMessages,
        userMessages,
        dismissBlockingUI,
        dismissAndSettle,
        isPromptReady,
        waitForEnabled,
        uploadOverlayVisible,
        isStopVisible,
        waitForGenerationEnd,
        attachFiles,
        typePrompt,
        pressSendAndConfirm,
        sendQuestion,
        waitForAnswer,
        looksLoggedOut,
        resetComposer,
        startPopupMonitor,
        buildFullPrompt,
        buildTextPayload,
        stageTempPayload,
        buildDeliveryPlan,
        buildTransmissionFinale,
        splitPayloadChunks,
        buildTransmissionPlan,
    } = deps;

    async function getConversationId(page) {
        let match = page.url().match(CONVERSATION_URL_RE);
        const deadline = Date.now() + 2000;
        while (!match && Date.now() < deadline) {
            await page.waitForTimeout(250);
            match = page.url().match(CONVERSATION_URL_RE);
        }
        return match ? match[1] : require("crypto").randomUUID();
    }

    async function getConversationTitle(page) {
        const title = (await page.title().catch(() => "")).replace(TITLE_SUFFIX_RE, "").trim();
        return title || null;
    }

    return {
        id: "chatgpt",
        name: "ChatGPT",
        url: CHATGPT_URL,
        loginUrl: CHATGPT_LOGIN_URL,
        conversationUrlRe: CONVERSATION_URL_RE,
        titleSuffixRe: TITLE_SUFFIX_RE,
        authCookiePrefixes: AUTH_COOKIE_PREFIXES,
        capabilities: {
            fileUpload: true,
            login: true,
            anonymousUsage: true,
        },

        navigate: gotoChatGPT,
        waitUntilReady: waitForChatGPTReady,
        startPopupMonitor: deps.startPopupMonitor,
        isLoggedIn: isLoggedInViaCookies,
        isOnAuthPage,
        runLoginFlow: (page, context) => runLoginFlow(page, context),
        runLogoutFlow: (page, context) => runLogoutFlow(page, context),

        promptInput: (page) => promptInput(page),
        sendButton: (page) => sendButton(page),
        stopButton: (page) => stopButton(page),
        attachButton: (page) => attachButton(page),
        fileInput: (page) => fileInput(page),
        getAssistantMessages: (page) => assistantMessages(page),
        getUserMessages: (page) => userMessages(page),
        dismissBlockingUI: (page) => dismissBlockingUI(page),
        dismissAndSettle: (page, ms) => dismissAndSettle(page, ms),
        isPromptReady: (page) => isPromptReady(page),
        waitForEnabled: (page, input) => waitForEnabled(page, input),
        uploadOverlayVisible: (page) => uploadOverlayVisible(page),
        isStopVisible: (page) => isStopVisible(page),
        waitForGenerationEnd: (page, timeoutMs) => waitForGenerationEnd(page, timeoutMs),

        canUploadFiles: () => true,
        attachFiles: (page, files) => attachFiles(page, files),
        typePrompt: (page, input, text) => typePrompt(page, input, text),
        sendPrompt: (page) => pressSendAndConfirm(page),
        sendQuestion: (page, question, targetUrl, context) => sendQuestion(page, question, CHATGPT_URL, context),
        waitForAnswer: (page, countBefore, options) => waitForAnswer(page, countBefore, options),

        looksLoggedOut: (page) => looksLoggedOut(page),
        resetComposer: (page, targetUrl, context) => resetComposer(page, CHATGPT_URL, context),

        buildFullPrompt,
        buildTextPayload,
        stageTempPayload,
        buildDeliveryPlan,
        buildTransmissionFinale,
        splitPayloadChunks,
        buildTransmissionPlan,

        getConversationId,
        getConversationTitle,

        cleanup: () => {},
    };
}

module.exports = {
    createChatGptProvider,
    CHATGPT_URL,
    CHATGPT_LOGIN_URL,
    CONVERSATION_URL_RE,
    AUTH_COOKIE_PREFIXES,
    TITLE_SUFFIX_RE,
};
