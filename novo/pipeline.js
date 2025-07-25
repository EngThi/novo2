require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google-generative-ai');
const aiplatform = require('@google-cloud/aiplatform');
const { PredictionServiceClient } = aiplatform.v1;
const { helpers } = aiplatform;
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { GoogleAuth } = require('google-auth-library');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');

// --- Configuração ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_DRIVE_REFRESH_TOKEN = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SHEET_NAME = process.env.GOOGLE_SHEET_NAME;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const OAUTH_CLIENT_ID = '1060201687476-0c6m7fb4ttsmg84uibe6jh8utbmplr11.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';
const OAUTH_REDIRECT_URI = 'http://localhost:8080';

const PROJECT_ID = 'drive-uploader-466418';
const LOCATION = 'us-central1';
const PUBLISHER = 'google';
const MODEL = 'imagegeneration@005';
const OUTPUT_PATH = 'novo/output';
const ASSETS_PATH = 'novo/assets';

// --- Mapeamento de Colunas da Planilha ---
const COLUMN_MAP = {
    ID: 'A',
    TEMA: 'B',
    STATUS: 'C',
    ROTEIRO: 'D',
    PROMPTS: 'E',
    URL_NARRACAO: 'F',
    URL_VIDEO: 'G',
    DATA_PROCESSAMENTO: 'H',
    ERRO: 'I',
};
// --------------------

// --- Funções Auxiliares ---
async function retry(fn, retries = 3, delay = 2000, fnName = 'operação') {
    try {
        return await fn();
    } catch (error) {
        if (retries > 0) {
            console.warn(`A ${fnName} falhou. Tentando novamente em ${delay / 1000}s... (Tentativas restantes: ${retries})`);
            await new Promise(res => setTimeout(res, delay));
            return retry(fn, retries - 1, delay * 2, fnName);
        } else {
            console.error(`A ${fnName} falhou após todas as tentativas.`);
            throw error;
        }
    }
}

const getSheetsClient = () => {
    const oauth2Client = new google.auth.OAuth2(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REDIRECT_URI);
    oauth2Client.setCredentials({ refresh_token: GOOGLE_DRIVE_REFRESH_TOKEN });
    return google.sheets({ version: 'v4', auth: oauth2Client });
};

const getDriveClient = () => {
    const oauth2Client = new google.auth.OAuth2(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REDIRECT_URI);
    oauth2Client.setCredentials({ refresh_token: GOOGLE_DRIVE_REFRESH_TOKEN });
    return google.drive({ version: 'v3', auth: oauth2Client });
};
// --------------------

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const textModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

async function findNextPendingTask(sheets) {
    console.log("TAREFA: Procurando por um vídeo 'Pendente'...");
    const range = `'${GOOGLE_SHEET_NAME}'!${COLUMN_MAP.STATUS}:${COLUMN_MAP.STATUS}`;
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: range,
    });

    const statuses = response.data.values;
    if (statuses) {
        for (let i = 0; i < statuses.length; i++) {
            if (statuses[i][0] === 'Pendente') {
                const row = i + 1;
                console.log(`TAREFA: Tarefa encontrada na linha ${row}.`);
                return row;
            }
        }
    }
    console.log("TAREFA: Nenhuma tarefa pendente encontrada.");
    return null;
}

async function getTaskData(sheets, row) {
    const range = `'${GOOGLE_SHEET_NAME}'!A${row}:I${row}`;
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range });
    const values = response.data.values ? response.data.values[0] : [];
    return {
        id: values[0],
        tema: values[1],
        status: values[2],
        roteiro: values[3],
        prompts: values[4],
        urlNarracao: values[5],
        urlVideo: values[6],
    };
}

async function updateCell(sheets, row, column, value) {
    const range = `'${GOOGLE_SHEET_NAME}'!${column}${row}`;
    await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[value]] },
    });
}

// ... (Funções de geração de conteúdo como gerarRoteiro, gerarImagens, etc. permanecem as mesmas, mas serão chamadas pelo orquestrador)
// --- Funções do Pipeline (Etapas) ---

async function gerarRoteiro(topic) {
    console.log(`ETAPA: Gerando roteiro para: "${topic}"...`);
    const prompt = `Crie um roteiro detalhado para um vídeo do YouTube com o título "${topic}". O roteiro deve ter cerca de 3 minutos, dividido em introdução, 3 seções principais e uma conclusão.`;
    const result = await textModel.generateContent(prompt);
    const script = result.response.text();
    await fs.writeFile(path.join(OUTPUT_PATH, 'roteiro.txt'), script);
    console.log("ETAPA: Roteiro gerado com sucesso.");
    return script;
}

async function criarPromptsDeImagem(script) {
    console.log("ETAPA: Analisando roteiro para criar prompts de imagem...");
    const prompt = `Sua tarefa é analisar um roteiro de vídeo e gerar prompts para um modelo de imagem. Analise o roteiro dentro das tags <roteiro>${script}</roteiro>. Extraia 5 cenas visuais cruciais. Para cada cena, crie um prompt principal e um prompt negativo. - O prompt principal deve ser em inglês, detalhado e com estilo fotorrealista. - O prompt negativo deve listar elementos a serem evitados, como 'desenho, texto, logos, feio, deformado'. Sua resposta deve ser APENAS um array JSON contendo 5 objetos. Cada objeto deve ter as chaves "prompt" e "negativePrompt".`;
    const result = await textModel.generateContent(prompt);
    let jsonString = result.response.text().trim().replace(/```json/g, "").replace(/```/g, "");
    const prompts = JSON.parse(jsonString);
    console.log(`ETAPA: ${prompts.length} prompts de imagem criados.`);
    return JSON.stringify(prompts, null, 2); // Salva como string JSON na planilha
}

async function gerarImagens(promptsJson, vertexAiClient) {
    console.log("ETAPA: Gerando imagens com Vertex AI...");
    const prompts = JSON.parse(promptsJson);
    const imageDir = path.join(OUTPUT_PATH, 'images');
    await fs.mkdir(imageDir, { recursive: true });
    const endpoint = `projects/${PROJECT_ID}/locations/${LOCATION}/publishers/${PUBLISHER}/models/${MODEL}`;
    const imagePaths = [];

    for (let i = 0; i < prompts.length; i++) {
        const item = prompts[i];
        console.log(`  - Gerando imagem ${i + 1}/${prompts.length}...`);
        const instance = helpers.toValue({ prompt: item.prompt });
        const parameters = helpers.toValue({ sampleCount: 1 });
        const request = { endpoint, instances: [instance], parameters };

        try {
            const [response] = await vertexAiClient.predict(request);
            const imageBase64 = response.predictions[0].structValue.fields.bytesBase64Encoded.stringValue;
            const filePath = path.join(imageDir, `image_${i + 1}.png`);
            await fs.writeFile(filePath, Buffer.from(imageBase64, 'base64'));
            imagePaths.push(filePath);
        } catch (error) {
            if (error.details && error.details.includes("violates our policies")) {
                console.warn(`AVISO: Prompt de imagem violou políticas de segurança. Pulando.`);
                continue;
            }
            throw error;
        }
    }
    if (imagePaths.length === 0) throw new Error("Nenhuma imagem pôde ser gerada.");
    console.log(`ETAPA: ${imagePaths.length} imagens geradas com sucesso.`);
    return imagePaths;
}

async function gerarNarracao(script, textToSpeechClient) {
    console.log("ETAPA: Gerando narração...");
    const request = {
        input: { text: script },
        voice: { languageCode: 'pt-BR', ssmlGender: 'FEMALE', name: 'pt-BR-Wavenet-B' },
        audioConfig: { audioEncoding: 'MP3' },
    };
    const [response] = await textToSpeechClient.synthesizeSpeech(request);
    const audioFilePath = path.join(OUTPUT_PATH, 'narration.mp3');
    await fs.writeFile(audioFilePath, response.audioContent, 'binary');
    console.log(`ETAPA: Narração salva em: ${audioFilePath}`);
    return audioFilePath;
}

async function montarVideo(narrationPath, imagePaths) {
    console.log("ETAPA: Montando vídeo final...");
    const outputPath = path.join(OUTPUT_PATH, 'video_final.mp4');
    const musicDir = path.join(ASSETS_PATH, 'music');
    const musicFiles = await fs.readdir(musicDir);
    if (musicFiles.length === 0) throw new Error("Nenhuma música encontrada na pasta de assets.");
    
    const musicPath = path.join(musicDir, musicFiles[Math.floor(Math.random() * musicFiles.length)]);
    console.log(`  - Trilha sonora selecionada: ${path.basename(musicPath)}`);

    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(narrationPath, (err, metadata) => {
            if (err) return reject(new Error(`Erro ao ler áudio: ${err.message}`));
            
            const audioDuration = metadata.format.duration;
            const imageDuration = audioDuration / imagePaths.length;
            const command = ffmpeg();

            imagePaths.forEach(imgPath => command.input(imgPath).loop(imageDuration));
            command.addInput(narrationPath).addInput(musicPath);

            let filterComplex = imagePaths.map((_, i) => 
                `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1,setsar=1,format=yuv420p,zoompan=z='min(zoom+0.001,1.1)':d=25*${imageDuration}:s=1920x1080[v${i}]`
            ).join(';');
            
            const xfadeFilters = imagePaths.slice(1).map((_, i) => {
                const offset = (i + 1) * imageDuration;
                const prevStream = i === 0 ? `[v${i}]` : `[vout${i-1}]`;
                return `${prevStream}[v${i+1}]xfade=transition=fade:duration=1:offset=${offset}[vout${i}]`;
            }).join(';');
            
            const audioMix = `[${imagePaths.length}:a]volume=1.0[a0];[${imagePaths.length+1}:a]volume=0.15[a1];[a0][a1]amix=inputs=2:duration=first[a]`;

            command.complexFilter(`${filterComplex};${xfadeFilters};${audioMix}`, [`vout${imagePaths.length-2}`, 'a']);
            command.outputOptions(['-c:v libx264', '-c:a aac', '-pix_fmt yuv420p', '-shortest'])
                .on('end', () => resolve(outputPath))
                .on('error', (err) => reject(new Error(`Erro no FFmpeg: ${err.message}`)))
                .save(outputPath);
        });
    });
}


async function uploadParaDrive(filePath) {
    console.log(`ETAPA: Fazendo upload do arquivo '${path.basename(filePath)}' para o Google Drive...`);
    const drive = getDriveClient();
    const file = await drive.files.create({
        requestBody: { name: path.basename(filePath) },
        media: { body: require('fs').createReadStream(filePath) },
    });
    return `https://drive.google.com/file/d/${file.data.id}/view`;
}


// --- Orquestrador Principal ---
async function executarPipeline() {
    const sheets = getSheetsClient();
    const taskRow = await findNextPendingTask(sheets);

    if (!taskRow) {
        console.log("ORQUESTRADOR: Nenhum trabalho a fazer. Encerrando.");
        return;
    }

    try {
        await updateCell(sheets, taskRow, COLUMN_MAP.STATUS, 'Em Progresso');
        let taskData = await getTaskData(sheets, taskRow);
        
        const authIA = new GoogleAuth({ keyFile: 'novo/google-drive-credentials.json', scopes: 'https://www.googleapis.com/auth/cloud-platform' });
        const vertexAiClient = new PredictionServiceClient({ apiEndpoint: `${LOCATION}-aiplatform.googleapis.com`, auth: authIA });
        const textToSpeechClient = new TextToSpeechClient({ auth: authIA });

        // ETAPA 1: Roteiro
        if (!taskData.roteiro) {
            await updateCell(sheets, taskRow, COLUMN_MAP.STATUS, 'Em Progresso - Roteiro');
            const roteiro = await retry(() => gerarRoteiro(taskData.tema), 3, 2000, 'geração de roteiro');
            await updateCell(sheets, taskRow, COLUMN_MAP.ROTEIRO, roteiro);
            taskData.roteiro = roteiro;
        }

        // ETAPA 2: Prompts de Imagem
        if (!taskData.prompts) {
            await updateCell(sheets, taskRow, COLUMN_MAP.STATUS, 'Em Progresso - Prompts');
            const prompts = await retry(() => criarPromptsDeImagem(taskData.roteiro), 3, 2000, 'criação de prompts');
            await updateCell(sheets, taskRow, COLUMN_MAP.PROMPTS, prompts);
            taskData.prompts = prompts;
        }

        // ETAPA 3: Geração de Imagens
        await updateCell(sheets, taskRow, COLUMN_MAP.STATUS, 'Em Progresso - Imagens');
        const imagePaths = await retry(() => gerarImagens(taskData.prompts, vertexAiClient), 1, 0, 'geração de imagens'); // Retry na geração de imagem pode ser custoso

        // ETAPA 4: Narração
        if (!taskData.urlNarracao) {
            await updateCell(sheets, taskRow, COLUMN_MAP.STATUS, 'Em Progresso - Narração');
            const narrationPath = await retry(() => gerarNarracao(taskData.roteiro, textToSpeechClient), 3, 2000, 'geração de narração');
            const narrationUrl = await retry(() => uploadParaDrive(narrationPath), 3, 2000, 'upload da narração');
            await updateCell(sheets, taskRow, COLUMN_MAP.URL_NARRACAO, narrationUrl);
            taskData.urlNarracao = narrationUrl;
        }

        // ETAPA 5: Montagem do Vídeo
        if (!taskData.urlVideo) {
            await updateCell(sheets, taskRow, COLUMN_MAP.STATUS, 'Em Progresso - Vídeo');
            const videoPath = await montarVideo(path.join(OUTPUT_PATH, 'narration.mp3'), imagePaths);
            const videoUrl = await retry(() => uploadParaDrive(videoPath), 3, 2000, 'upload do vídeo');
            await updateCell(sheets, taskRow, COLUMN_MAP.URL_VIDEO, videoUrl);
            taskData.urlVideo = videoUrl;
        }

        await updateCell(sheets, taskRow, COLUMN_MAP.DATA_PROCESSAMENTO, new Date().toISOString());
        await updateCell(sheets, taskRow, COLUMN_MAP.STATUS, 'Concluído');
        await sendToDiscord(`✅ Pipeline concluído com sucesso para o tema: **${taskData.tema}**.`);
        console.log("ORQUESTRADOR: Processo concluído com sucesso!");

    } catch (error) {
        console.error("ORQUESTRADOR: Pipeline falhou!", error.message);
        await updateCell(sheets, taskRow, COLUMN_MAP.STATUS, 'Erro');
        await updateCell(sheets, taskRow, COLUMN_MAP.ERRO, error.message);
        await sendToDiscord(`❌ Pipeline falhou na linha ${taskRow}.
**Erro:** ${error.message}`, true);
    }
}

executarPipeline();
