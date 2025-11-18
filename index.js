import { saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';

// 插件名称和默认设置
const extensionName = 'secondary-api-assistant';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const defaultSettings = {
    enabled: true,
    apiUrl: '',
    apiKey: '',
    modelEndpoint: '/models',
    selectedModel: '',
    customModel: '',
    useCustomModel: false,
    systemPrompt: 'You are a helpful assistant analyzing the conversation.',
    contextCount: 10,
    temperature: 0.7,
    maxTokens: 500,

    // 正则：捕获式 + 替换式
    inputRegexPattern: '',
    inputRegexReplace: '',
    outputRegexPattern: '',
    outputRegexReplace: '',

    // 旧字段（兼容老配置，内部不再直接使用）
    inputRegex: '',
    outputRegex: '',

    modelsCache: [],
    results: []
};

// 统一的上下文获取函数（优先使用 SillyTavern.getContext）
function getSTContext() {
    try {
        if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
            return window.SillyTavern.getContext();
        }
    } catch (e) {
        console.warn('[Secondary API] SillyTavern.getContext() 调用失败:', e);
    }

    try {
        if (typeof getContext === 'function') {
            return getContext();
        }
    } catch (e) {
        console.warn('[Secondary API] getContext() 调用失败:', e);
    }

    console.warn('[Secondary API] 无法获取上下文，返回空聊天数组');
    return { chat: [] };
}

// 记录最近一次已注入的用户消息索引，防止同一条消息被重复注入
let lastInjectedMessageIndex = null;

// 防止同一条消息多次调用副 API 的签名和时间
let lastProcessedMessageSignature = null;
let lastProcessedAt = 0;

/**
 * 为「当前最后一条用户消息」生成一个签名，用于去重。
 * 签名包含：索引 + 文本长度 + 文本末尾部分。
 */
function computeLastUserMessageSignature() {
    const context = getSTContext();
    const chat = context.chat || [];

    if (!Array.isArray(chat) || chat.length === 0) {
        return null;
    }

    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (msg && (msg.is_user || msg.role === 'user')) {
            const text = msg.mes || '';
            const tail = text.length > 32 ? text.slice(-32) : text;
            return `${i}:${text.length}:${tail}`;
        }
    }

    return null;
}

/**
 * 将副 API 的结果追加到最后一条用户消息的末尾，并持久化保存到聊天记录和 DOM。
 * @param {string} result
 */
function injectResultIntoLastUserMessage(result) {
    if (!result) {
        console.log('[Secondary API] Empty result, skip injection');
        return;
    }

    try {
        const context = getSTContext();
        const chat = context.chat || [];

        if (!Array.isArray(chat) || chat.length === 0) {
            console.log('[Secondary API] No chat available for injection');
            return;
        }

        // 寻找最后一条用户消息
        let targetIndex = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (msg && (msg.is_user || msg.role === 'user')) {
                targetIndex = i;
                break;
            }
        }

        if (targetIndex === -1) {
            console.log('[Secondary API] No user message found for injection');
            return;
        }

        const targetMessage = chat[targetIndex];
        if (!targetMessage) {
            console.log('[Secondary API] Target message is undefined');
            return;
        }

        const originalText = targetMessage.mes || '';

        // 如果这条消息已经包含本次结果，并且索引相同，则不再重复注入
        if (originalText.includes(result) && lastInjectedMessageIndex === targetIndex) {
            console.log('[Secondary API] Result already injected into this user message, skipping');
            return;
        }

        const injectionText = '\n\n' + result;

        // 在消息“底部”追加结果内容
        targetMessage.mes = originalText + injectionText;

        // 持久化保存
        if (typeof context.saveChat === 'function') {
            context.saveChat();
        } else if (typeof window.saveChat === 'function') {
            window.saveChat();
        }

        // 同步更新 DOM，立即显示修改
        try {
            const messageElement = document.querySelector(
                `#chat .mes[mesid="${targetIndex}"] .mes_text`
            );
            if (messageElement) {
                messageElement.innerHTML = targetMessage.mes;
            }
        } catch (domError) {
            console.warn('[Secondary API] Failed to update DOM for injected message:', domError);
        }

        lastInjectedMessageIndex = targetIndex;
        console.log('[Secondary API] Result injected into last user message at index', targetIndex);
    } catch (error) {
        console.error('[Secondary API] Failed to inject result into last user message:', error);
    }
}

// 正则应用：pattern + replace（支持捕获组）
// pattern 为空时直接返回原文本
function applyRegex(text, pattern, replacement) {
    if (!pattern) {
        return text;
    }

    try {
        const re = new RegExp(pattern, 'g');
        const rep = typeof replacement === 'string' ? replacement : '';
        return text.replace(re, rep);
    } catch (error) {
        console.error('[Secondary API] Regex apply failed:', error);
        return text;
    }
}

// 加载设置（包含旧字段迁移）
async function loadSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = { ...defaultSettings };
    } else {
        // 兼容旧字段：如果新字段为空而旧字段有值，则迁移一次
        const old = extension_settings[extensionName];

        if (!old.inputRegexPattern && old.inputRegex) {
            old.inputRegexPattern = old.inputRegex;
        }
        if (!old.outputRegexPattern && old.outputRegex) {
            old.outputRegexPattern = old.outputRegex;
        }

        extension_settings[extensionName] = {
            ...defaultSettings,
            ...old
        };
    }

    const settings = extension_settings[extensionName];

    $('#secondary_api_enabled').prop('checked', settings.enabled);
    $('#secondary_api_url').val(settings.apiUrl);
    $('#secondary_api_key').val(settings.apiKey);
    $('#secondary_api_model_endpoint').val(settings.modelEndpoint);
    $('#secondary_api_custom_model').val(settings.customModel);
    $('#secondary_api_use_custom_model').prop('checked', settings.useCustomModel);
    $('#secondary_api_system_prompt').val(settings.systemPrompt);
    $('#secondary_api_context_count').val(settings.contextCount);
    $('#secondary_api_temperature').val(settings.temperature);
    $('#secondary_api_max_tokens').val(settings.maxTokens);

    // 正则字段
    $('#secondary_api_input_regex_pattern').val(settings.inputRegexPattern);
    $('#secondary_api_input_regex_replace').val(settings.inputRegexReplace);
    $('#secondary_api_output_regex_pattern').val(settings.outputRegexPattern);
    $('#secondary_api_output_regex_replace').val(settings.outputRegexReplace);

    $('#secondary_api_trigger_on_send').prop('checked', settings.triggerOnSend);
    $('#secondary_api_trigger_on_enter').prop('checked', settings.triggerOnEnter);
    $('#secondary_api_trigger_on_button').prop('checked', settings.triggerOnButton);

    // 更新模型列表
    updateModelSelectUI();

    // 更新结果列表
    updateResultsList();
}

// 保存设置
function saveSettings() {
    const settings = extension_settings[extensionName];

    settings.enabled = $('#secondary_api_enabled').prop('checked');
    settings.apiUrl = $('#secondary_api_url').val();
    settings.apiKey = $('#secondary_api_key').val();
    settings.modelEndpoint = $('#secondary_api_model_endpoint').val();
    settings.selectedModel = $('#secondary_api_model_select').val();
    settings.customModel = $('#secondary_api_custom_model').val();
    settings.useCustomModel = $('#secondary_api_use_custom_model').prop('checked');
    settings.systemPrompt = $('#secondary_api_system_prompt').val();
    settings.contextCount = parseInt($('#secondary_api_context_count').val()) || 10;
    settings.temperature = parseFloat($('#secondary_api_temperature').val()) || 0.7;
    settings.maxTokens = parseInt($('#secondary_api_max_tokens').val()) || 500;

    // 正则字段
    settings.inputRegexPattern = $('#secondary_api_input_regex_pattern').val();
    settings.inputRegexReplace = $('#secondary_api_input_regex_replace').val();
    settings.outputRegexPattern = $('#secondary_api_output_regex_pattern').val();
    settings.outputRegexReplace = $('#secondary_api_output_regex_replace').val();

    // 兼容旧字段：简单同步 pattern
    settings.inputRegex = settings.inputRegexPattern;
    settings.outputRegex = settings.outputRegexPattern;

    settings.triggerOnSend = $('#secondary_api_trigger_on_send').prop('checked');
    settings.triggerOnEnter = $('#secondary_api_trigger_on_enter').prop('checked');
    settings.triggerOnButton = $('#secondary_api_trigger_on_button').prop('checked');

    saveSettingsDebounced();
}

// 获取当前选中的模型
function getCurrentModel() {
    const settings = extension_settings[extensionName];

    if (settings.useCustomModel && settings.customModel) {
        return settings.customModel;
    }

    if (settings.selectedModel) {
        return settings.selectedModel;
    }

    return 'gpt-4o-mini';
}

// 获取最近 N 条对话作为上下文，并应用输入正则
function getRecentContext(contextCount) {
    const settings = extension_settings[extensionName];
    const context = getSTContext();
    const chat = context.chat || [];
    const messages = [];

    if (!Array.isArray(chat) || chat.length === 0) {
        console.warn('[Secondary API] Chat is empty or invalid');
        return messages;
    }

    const startIndex = Math.max(0, chat.length - contextCount);

    for (let i = startIndex; i < chat.length; i++) {
        const message = chat[i];

        if (!message || typeof message.mes !== 'string') {
            continue;
        }

        // 跳过空消息
        if (!message.mes.trim()) {
            continue;
        }

        const role = message.is_user ? 'user' : 'assistant';
        let content = message.mes;

        // 对输入应用正则（捕获式 + 替换式）
        content = applyRegex(
            content,
            settings.inputRegexPattern,
            settings.inputRegexReplace
        );

        messages.push({
            role,
            content
        });
    }

    console.log('[Secondary API] Context messages prepared:', messages.length);

    return messages;
}

// 调用副API
async function callSecondaryAPI() {
    const settings = extension_settings[extensionName];

    if (!settings.enabled || !settings.apiUrl) {
        console.log('Secondary API is disabled or not configured');
        return null;
    }

    console.log('[Secondary API] Starting API call...');

    try {
        const contextMessages = getRecentContext(settings.contextCount);

        const requestBody = {
            model: getCurrentModel(),
            messages: [
                {
                    role: 'system',
                    content: settings.systemPrompt || ''
                },
                ...contextMessages
            ],
            temperature: settings.temperature,
            max_tokens: settings.maxTokens
        };

        console.log('[Secondary API] System Prompt:', settings.systemPrompt);
        console.log('[Secondary API] Context Messages Count:', contextMessages.length);
        console.log('[Secondary API] Full Request (messages only):', JSON.stringify(requestBody.messages, null, 2));

        const response = await fetch(settings.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(settings.apiKey ? { 'Authorization': `Bearer ${settings.apiKey}` } : {})
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API request failed: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        console.log('[Secondary API] Raw Response:', data);

        let result = '';

        if (data.choices && data.choices[0]) {
            result = data.choices[0].message?.content || data.choices[0].text || '';
        } else if (data.response) {
            result = data.response;
        } else if (typeof data === 'string') {
            result = data;
        } else {
            result = JSON.stringify(data);
        }

        // 应用输出正则（捕获式 + 替换式）
        result = applyRegex(
            result,
            settings.outputRegexPattern,
            settings.outputRegexReplace
        );

        console.log('[Secondary API] Final result:', result);

        return {
            result: result,
            input: {
                systemPrompt: settings.systemPrompt || '',
                messages: contextMessages
            },
            fullContext: contextMessages
        };
    } catch (error) {
        console.error('[Secondary API] Error calling secondary API:', error);
        return null;
    }
}

// 添加结果到历史
function addResult(input, output, model) {
    const settings = extension_settings[extensionName];

    if (!Array.isArray(settings.results)) {
        settings.results = [];
    }

    settings.results.push({
        timestamp: Date.now(),
        input: JSON.stringify(input, null, 2),
        output: output,
        model: model || getCurrentModel()
    });

    saveSettingsDebounced();
    updateResultsList();
}

// 更新结果列表 UI
function updateResultsList() {
    const settings = extension_settings[extensionName];

    if (!Array.isArray(settings.results)) {
        settings.results = [];
    }

    const results = settings.results;
    const $resultsList = $('#secondary_api_results_list');

    $resultsList.empty();

    if (results.length === 0) {
        $resultsList.append('<div class="secondary-api-no-results">No results yet</div>');
        return;
    }

    results.slice().reverse().forEach((result, index) => {
        const realIndex = results.length - 1 - index;
        const $resultItem = $(`
            <div class="secondary-api-result-item" data-index="${realIndex}">
                <div class="secondary-api-result-header">
                    <span class="secondary-api-result-time">${new Date(result.timestamp).toLocaleString()}</span>
                    <span class="secondary-api-result-model">${result.model || 'Unknown'}</span>
                    <div class="secondary-api-result-actions">
                        <button class="secondary-api-copy-btn menu_button" title="Copy">
                            <i class="fa-solid fa-copy"></i>
                        </button>
                        <button class="secondary-api-delete-btn menu_button" title="Delete">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
                <div class="secondary-api-result-content">
                    <div class="secondary-api-result-input">
                        <strong>Input:</strong> <pre style="white-space:pre-wrap;">${result.input}</pre>
                    </div>
                    <div class="secondary-api-result-output">
                        <strong>Output:</strong> ${result.output}
                    </div>
                </div>
            </div>
        `);

        $resultsList.append($resultItem);
    });
}

// 获取模型列表
async function fetchModels() {
    const settings = extension_settings[extensionName];

    if (!settings.apiUrl || !settings.modelEndpoint) {
        alert('Please configure API URL and Model Endpoint first.');
        return;
    }

    const endpointUrl = settings.apiUrl.replace(/\/$/, '') + settings.modelEndpoint;

    try {
        const response = await fetch(endpointUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...(settings.apiKey ? { 'Authorization': `Bearer ${settings.apiKey}` } : {})
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Model list request failed: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        console.log('[Secondary API] Models response:', data);

        let models = [];

        if (Array.isArray(data)) {
            models = data;
        } else if (Array.isArray(data.data)) {
            models = data.data;
        } else if (Array.isArray(data.models)) {
            models = data.models;
        }

        const modelNames = models.map(m => {
            if (typeof m === 'string') return m;
            if (m.id) return m.id;
            if (m.name) return m.name;
            return JSON.stringify(m);
        });

        settings.modelsCache = modelNames;
        saveSettingsDebounced();

        updateModelSelectUI();

        alert('Models fetched successfully.');
    } catch (error) {
        console.error('[Secondary API] Error fetching models:', error);
        alert('Failed to fetch models. See console for details.');
    }
}

// 更新模型选择下拉框
function updateModelSelectUI() {
    const settings = extension_settings[extensionName];

    const $modelSelect = $('#secondary_api_model_select');
    const $customModelRow = $('#secondary_api_custom_model_row');
    const $modelRow = $('#secondary_api_model_row');

    if (!$modelSelect.length) return;

    $modelSelect.empty();
    $modelSelect.append('<option value="">-- Select Model --</option>');

    if (Array.isArray(settings.modelsCache) && settings.modelsCache.length > 0) {
        settings.modelsCache.forEach(model => {
            const $option = $(`<option value="${model}">${model}</option>`);
            $modelSelect.append($option);
        });
    }

    if (settings.selectedModel) {
        $modelSelect.val(settings.selectedModel);
    }

    if (settings.useCustomModel) {
        $customModelRow.show();
        $modelRow.hide();
    } else {
        $customModelRow.hide();
        $modelRow.show();
    }
}

// 处理消息发送事件（统一入口，内部做去重）
async function handleMessageSent(triggerInfo) {
    console.log('[Secondary API] Message event received from', triggerInfo?.source);

    const settings = extension_settings[extensionName];

    if (!settings || !settings.enabled) {
        console.log('[Secondary API] Extension is disabled');
        return;
    }

    // 延迟执行，确保消息已经添加到聊天历史
    setTimeout(async () => {
        try {
            const signature = computeLastUserMessageSignature();
            if (!signature) {
                console.log('[Secondary API] No last user message for signature');
                return;
            }

            const now = Date.now();

            // 在 3 秒窗口内，同一签名只处理一次
            if (signature === lastProcessedMessageSignature && now - lastProcessedAt < 3000) {
                console.log('[Secondary API] Duplicate trigger detected, skipping. source:', triggerInfo?.source);
                return;
            }

            lastProcessedMessageSignature = signature;
            lastProcessedAt = now;

            const context = getSTContext();
            const chat = context.chat || [];

            if (chat.length === 0) {
                console.log('[Secondary API] No messages in chat');
                return;
            }

            console.log('[Secondary API] Current chat length:', chat.length);
            console.log('[Secondary API] Will fetch last', settings.contextCount, 'messages');

            const apiResponse = await callSecondaryAPI();

            if (apiResponse && apiResponse.result) {
                addResult(apiResponse.input, apiResponse.result, getCurrentModel());

                console.log('[Secondary API] Result saved successfully');

                // 在结果产出后，将结果追加到最后一条用户消息的底部
                injectResultIntoLastUserMessage(apiResponse.result);
            }
        } catch (error) {
            console.error('[Secondary API] Error processing message:', error);
        }
    }, 800); // 确保消息已保存
}

// jQuery初始化 + UI
jQuery(async () => {
    const settingsHtml = `
        <div id="secondary_api_assistant">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Secondary API Assistant</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="secondary-api-settings">
                        <!-- 启用开关 -->
                        <div class="secondary-api-setting-row">
                            <label class="checkbox_label">
                                <input id="secondary_api_enabled" type="checkbox">
                                <span>Enable Secondary API</span>
                            </label>
                        </div>
                        
                        <!-- API 基本设置 -->
                        <div class="secondary-api-setting-group">
                            <h4>API Settings</h4>
                            <div class="secondary-api-setting-row">
                                <label for="secondary_api_url">API URL:</label>
                                <input id="secondary_api_url" type="text" class="text_pole" placeholder="https://api.openai.com/v1/chat/completions">
                            </div>
                            <div class="secondary-api-setting-row">
                                <label for="secondary_api_key">API Key (optional):</label>
                                <input id="secondary_api_key" type="password" class="text_pole" placeholder="sk-...">
                            </div>
                            <div class="secondary-api-setting-row">
                                <label for="secondary_api_model_endpoint">Model List Endpoint:</label>
                                <div class="secondary-api-input-group">
                                    <input id="secondary_api_model_endpoint" type="text" class="text_pole" placeholder="/models or /v1/models">
                                    <button id="secondary_api_fetch_models" class="menu_button">
                                        <i class="fa-solid fa-refresh"></i> Fetch Models
                                    </button>
                                </div>
                            </div>
                            <div class="secondary-api-setting-row">
                                <label class="checkbox_label">
                                    <input id="secondary_api_use_custom_model" type="checkbox">
                                    <span>Use Custom Model Name</span>
                                </label>
                            </div>
                            <div id="secondary_api_model_row" class="secondary-api-setting-row">
                                <label for="secondary_api_model_select">Select Model:</label>
                                <select id="secondary_api_model_select" class="text_pole">
                                    <option value="">-- Select Model --</option>
                                </select>
                            </div>
                            <div id="secondary_api_custom_model_row" class="secondary-api-setting-row" style="display:none;">
                                <label for="secondary_api_custom_model">Custom Model Name:</label>
                                <input id="secondary_api_custom_model" type="text" class="text_pole" placeholder="gpt-4-turbo-preview">
                            </div>
                            <div class="secondary-api-setting-row">
                                <button id="secondary_api_test_btn" class="menu_button">
                                    <i class="fa-solid fa-plug"></i> Test API
                                </button>
                            </div>
                        </div>
                        
                        <!-- 系统提示词 -->
                        <div class="secondary-api-setting-group">
                            <h4>System Prompt</h4>
                            <textarea id="secondary_api_system_prompt" class="text_pole" rows="4" placeholder="Enter system prompt for the secondary API..."></textarea>
                        </div>
                        
                        <!-- 生成参数 -->
                        <div class="secondary-api-setting-group">
                            <h4>Generation Parameters</h4>
                            <div class="secondary-api-setting-row">
                                <label for="secondary_api_context_count">Context Messages:</label>
                                <input id="secondary_api_context_count" type="number" class="text_pole" min="1" max="100" value="10">
                            </div>
                            <div class="secondary-api-setting-row">
                                <label for="secondary_api_temperature">Temperature:</label>
                                <input id="secondary_api_temperature" type="number" class="text_pole" step="0.01" min="0" max="2" value="0.7">
                            </div>
                            <div class="secondary-api-setting-row">
                                <label for="secondary_api_max_tokens">Max Tokens:</label>
                                <input id="secondary_api_max_tokens" type="number" class="text_pole" min="1" max="4000" value="500">
                            </div>
                        </div>
                        
                        <!-- 触发设置 -->
                        <div class="secondary-api-setting-group">
                            <h4>Trigger Settings</h4>
                            <div class="secondary-api-setting-row">
                                <label class="checkbox_label">
                                    <input id="secondary_api_trigger_on_send" type="checkbox" checked>
                                    <span>Trigger on MESSAGE_SENT / USER_MESSAGE_RENDERED</span>
                                </label>
                            </div>
                            <div class="secondary-api-setting-row">
                                <label class="checkbox_label">
                                    <input id="secondary_api_trigger_on_enter" type="checkbox" checked>
                                    <span>Trigger on Enter key (fallback)</span>
                                </label>
                            </div>
                            <div class="secondary-api-setting-row">
                                <label class="checkbox_label">
                                    <input id="secondary_api_trigger_on_button" type="checkbox" checked>
                                    <span>Trigger on Send button click (fallback)</span>
                                </label>
                            </div>
                        </div>
                        
                        <!-- 正则设置：捕获式 + 替换式 -->
                        <div class="secondary-api-setting-group">
                            <h4>Regex Processing</h4>
                            <div class="secondary-api-setting-row">
                                <label for="secondary_api_input_regex_pattern">Input Regex (捕获式):</label>
                                <input id="secondary_api_input_regex_pattern" type="text" class="text_pole" placeholder="例如: \\[.*?\\]">
                            </div>
                            <div class="secondary-api-setting-row">
                                <label for="secondary_api_input_regex_replace">Input Replace (替换为):</label>
                                <input id="secondary_api_input_regex_replace" type="text" class="text_pole" placeholder="例如: 空串 或 $1">
                            </div>
                            <div class="secondary-api-setting-row">
                                <label for="secondary_api_output_regex_pattern">Output Regex (捕获式):</label>
                                <input id="secondary_api_output_regex_pattern" type="text" class="text_pole" placeholder="例如: \\[.*?\\]">
                            </div>
                            <div class="secondary-api-setting-row">
                                <label for="secondary_api_output_regex_replace">Output Replace (替换为):</label>
                                <input id="secondary_api_output_regex_replace" type="text" class="text_pole" placeholder="例如: 空串 或 $1">
                            </div>
                            <small>捕获式填写正则 Pattern，替换式填写替换文本（支持 $1 等捕获组）。</small>
                        </div>
                        
                        <!-- 结果显示 -->
                        <div class="secondary-api-setting-group">
                            <h4>Results History</h4>
                            <div class="secondary-api-results-controls">
                                <button id="secondary_api_clear_results" class="menu_button">
                                    <i class="fa-solid fa-broom"></i> Clear All
                                </button>
                                <button id="secondary_api_export_results" class="menu_button">
                                    <i class="fa-solid fa-download"></i> Export
                                </button>
                            </div>
                            <div id="secondary_api_results_list" class="secondary-api-results-list">
                                <!-- 结果将在这里显示 -->
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    const styleHtml = `
        <style id="secondary_api_assistant_styles">
            #secondary_api_assistant {
                margin-bottom: 10px;
            }
            
            #secondary_api_assistant .secondary-api-settings {
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
            
            #secondary_api_assistant .secondary-api-setting-group {
                border: 1px solid var(--SmartThemeBorderColor);
                padding: 10px;
                border-radius: 5px;
                margin-bottom: 5px;
            }
            
            #secondary_api_assistant .secondary-api-setting-group h4 {
                margin-top: 0;
                margin-bottom: 8px;
            }
            
            #secondary_api_assistant .secondary-api-setting-row {
                margin-bottom: 8px;
                display: flex;
                align-items: center;
                gap: 8px;
                flex-wrap: wrap;
            }
            
            #secondary_api_assistant .secondary-api-setting-row label {
                min-width: 160px;
            }
            
            #secondary_api_assistant .secondary-api-setting-row input[type="text"],
            #secondary_api_assistant .secondary-api-setting-row input[type="password"],
            #secondary_api_assistant .secondary-api-setting-row input[type="number"],
            #secondary_api_assistant .secondary-api-setting-row select,
            #secondary_api_assistant .secondary-api-setting-group textarea {
                flex: 1;
            }
            
            #secondary_api_assistant .secondary-api-input-group {
                display: flex;
                gap: 5px;
                width: 100%;
            }
            
            #secondary_api_assistant .secondary-api-input-group input {
                flex: 1;
            }
            
            #secondary_api_assistant .secondary-api-results-list {
                max-height: 300px;
                overflow: auto;
                border: 1px solid var(--SmartThemeBorderColor);
                border-radius: 5px;
                padding: 5px;
                background-color: var(--SmartThemeBodyColor);
            }
            
            #secondary_api_assistant .secondary-api-result-item {
                border-bottom: 1px solid var(--SmartThemeBorderColor);
                padding: 5px 0;
            }
            
            #secondary_api_assistant .secondary-api-result-item:last-child {
                border-bottom: none;
            }
            
            #secondary_api_assistant .secondary-api-result-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 8px;
                flex-wrap: wrap;
                gap: 10px;
            }
            
            .secondary-api-result-time {
                font-size: 0.85em;
                color: var(--SmartThemeQuoteColor);
            }
            
            .secondary-api-result-model {
                font-size: 0.85em;
                color: var(--SmartThemeEmColor);
                padding: 2px 6px;
                background: var(--SmartThemeBorderColor);
                border-radius: 3px;
            }
            
            .secondary-api-result-actions {
                display: flex;
                gap: 5px;
                margin-left: auto;
            }
            
            .secondary-api-result-actions button {
                padding: 2px 6px;
                font-size: 0.85em;
            }
            
            .secondary-api-no-results {
                text-align: center;
                padding: 10px;
                color: var(--SmartThemeQuoteColor);
            }
        </style>
    `;
    
    $('#extensions_settings').append(settingsHtml);
    $('head').append(styleHtml);
    
    // 初始化设置
    await loadSettings();
    
    // 事件绑定：设置变更
    $('#secondary_api_enabled').on('change', saveSettings);
    $('#secondary_api_url').on('input', saveSettings);
    $('#secondary_api_key').on('input', saveSettings);
    $('#secondary_api_model_endpoint').on('input', saveSettings);
    $('#secondary_api_model_select').on('change', saveSettings);
    $('#secondary_api_custom_model').on('input', saveSettings);
    $('#secondary_api_use_custom_model').on('change', function() {
        extension_settings[extensionName].useCustomModel = $(this).prop('checked');
        saveSettings();
        updateModelSelectUI();
    });
    $('#secondary_api_system_prompt').on('input', saveSettings);
    $('#secondary_api_context_count').on('input', saveSettings);
    $('#secondary_api_temperature').on('input', saveSettings);
    $('#secondary_api_max_tokens').on('input', saveSettings);

    $('#secondary_api_input_regex_pattern').on('input', saveSettings);
    $('#secondary_api_input_regex_replace').on('input', saveSettings);
    $('#secondary_api_output_regex_pattern').on('input', saveSettings);
    $('#secondary_api_output_regex_replace').on('input', saveSettings);

    $('#secondary_api_trigger_on_send').on('change', saveSettings);
    $('#secondary_api_trigger_on_enter').on('change', saveSettings);
    $('#secondary_api_trigger_on_button').on('change', saveSettings);
    
    // 模型列表按钮
    $('#secondary_api_fetch_models').on('click', fetchModels);
    
    // 测试按钮
    $('#secondary_api_test_btn').on('click', async () => {
        $('#secondary_api_test_btn').prop('disabled', true).text('Testing...');
        try {
            const result = await callSecondaryAPI();
            if (result && result.result) {
                alert('API call succeeded. See console and results list.');
                addResult(result.input, result.result, getCurrentModel());
            } else {
                alert('API call failed or returned empty result. See console.');
            }
        } finally {
            $('#secondary_api_test_btn').prop('disabled', false).text('Test API');
        }
    });
    
    // 清除结果按钮
    $('#secondary_api_clear_results').on('click', function() {
        if (confirm('Clear all results?')) {
            extension_settings[extensionName].results = [];
            saveSettingsDebounced();
            updateResultsList();
        }
    });
    
    // 导出结果按钮
    $('#secondary_api_export_results').on('click', function() {
        const results = extension_settings[extensionName].results || [];
        const dataStr = JSON.stringify(results, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `secondary-api-results-${Date.now()}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    });
    
    // 复制和删除按钮事件
    $(document).on('click', '.secondary-api-copy-btn', function() {
        const $item = $(this).closest('.secondary-api-result-item');
        const index = $item.data('index');
        const result = extension_settings[extensionName].results[index];
        
        if (result) {
            navigator.clipboard.writeText(result.output)
                .then(() => {
                    console.log('[Secondary API] Result copied to clipboard');
                })
                .catch(err => {
                    console.error('[Secondary API] Failed to copy result:', err);
                });
        }
    });
    
    $(document).on('click', '.secondary-api-delete-btn', function() {
        const $item = $(this).closest('.secondary-api-result-item');
        const index = $item.data('index');
        
        if (confirm('Delete this result?')) {
            extension_settings[extensionName].results.splice(index, 1);
            saveSettingsDebounced();
            updateResultsList();
        }
    });
    
    console.log('[Secondary API] Registering event listeners...');
    
    // 事件监听：绑定到 SillyTavern 的 eventSource
    if (eventSource) {
        const onEventSourceMessage = (data) => {
            const settings = extension_settings[extensionName];
            if (!settings || !settings.triggerOnSend) {
                return;
            }
            handleMessageSent({ source: 'eventSource', data });
        };

        eventSource.on(event_types.MESSAGE_SENT, onEventSourceMessage);
        eventSource.on(event_types.USER_MESSAGE_RENDERED, onEventSourceMessage);

        // 兼容一些旧事件名
        eventSource.on('messageSent', onEventSourceMessage);
        eventSource.on('userMessageSent', onEventSourceMessage);
        eventSource.on('sendUserMessage', onEventSourceMessage);

        eventSource.on(event_types.CHAT_CHANGED, (data) => {
            console.log('[Secondary API] Chat changed:', data);
            lastInjectedMessageIndex = null;
            lastProcessedMessageSignature = null;
            lastProcessedAt = 0;
        });
        
        console.log('[Secondary API] Event listeners registered');
    } else {
        console.error('[Secondary API] eventSource not found!');
    }
    
    // 备用：监听输入框的回车事件（受 triggerOnEnter 控制）
    $(document).on('keydown', '#send_textarea', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            const settings = extension_settings[extensionName];
            if (!settings || !settings.enabled || !settings.triggerOnEnter) return;

            const message = $(this).val();
            if (message) {
                console.log('[Secondary API] Detected Enter key with message:', message);
                setTimeout(() => {
                    handleMessageSent({ source: 'enter', message });
                }, 500);
            }
        }
    });
    
    // 备用：监听发送按钮点击（受 triggerOnButton 控制）
    $(document).on('click', '#send_but', function() {
        const settings = extension_settings[extensionName];
        if (!settings || !settings.enabled || !settings.triggerOnButton) return;

        const message = $('#send_textarea').val();
        if (message) {
            console.log('[Secondary API] Detected send button click with message:', message);
            setTimeout(() => {
                handleMessageSent({ source: 'button', message });
            }, 500);
        }
    });
    
    console.log('[Secondary API] Extension loaded successfully');
});

// 导出以便调试
window.secondaryAPIDebug = {
    testCall: callSecondaryAPI,
    getSettings: () => extension_settings[extensionName],
    handleMessage: handleMessageSent
};
