// server.js
require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Configuration OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Middlewares de sécurité
app.use(helmet());
app.use(morgan('combined'));
app.use(cors({
  origin: ['https://chat.audirep.fr', 'https://chat.cdafrance.eu', 'http://localhost'], // Ajustez selon vos besoins
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public')); // Pour servir les fichiers statiques

// Route pour servir index.html à la racine
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Dossier pour stocker les réponses du questionnaire
const RESPONSES_DIR = path.join(__dirname, 'responses');
const QUESTIONS_PATH = path.join(__dirname, 'public', 'questions.json');
const CSV_PATH = path.join(__dirname, 'public', 'questionnaire_qvt_responses.csv');

let cachedQuestionsDefinition = null;

async function loadQuestionsDefinition() {
  if (cachedQuestionsDefinition) {
    return cachedQuestionsDefinition;
  }

  try {
    const fileContent = await fs.readFile(QUESTIONS_PATH, 'utf-8');
    cachedQuestionsDefinition = JSON.parse(fileContent);
  } catch (error) {
    console.error('Erreur lors du chargement de questions.json:', error);
    cachedQuestionsDefinition = null;
  }

  return cachedQuestionsDefinition;
}

function flattenQuestions(definition) {
  const flattened = [];

  if (!definition || !Array.isArray(definition.sections)) {
    return flattened;
  }

  definition.sections.forEach((section) => {
    if (section.questions && Array.isArray(section.questions)) {
      section.questions.forEach((question) => {
        flattened.push(question);
      });
    }
  });

  return flattened;
}

function buildCsvConfiguration(flattenedQuestions) {
  const ratingIds = [];
  const radioIds = [];
  const openIds = [];

  flattenedQuestions.forEach((question) => {
    if (!question || !question.id) {
      return;
    }

    if (question.type === 'rating') {
      ratingIds.push(question.id);
    } else if (question.type === 'radio') {
      radioIds.push(question.id);
    } else if (question.type === 'open') {
      openIds.push(question.id);
    }
  });

  const introKey = openIds.find((id) => id === 'QO_INTRO') || null;
  const outroKey = openIds.find((id) => id === 'QO_OUTRO') || null;
  const middleOpenIds = openIds.filter((id) => id !== introKey && id !== outroKey);

  const orderedOpenIds = [];
  if (introKey) {
    orderedOpenIds.push(introKey);
  }
  middleOpenIds.forEach((id) => orderedOpenIds.push(id));
  if (outroKey) {
    orderedOpenIds.push(outroKey);
  }

  const columns = ['sessionId', 'timestampStart', 'timestampEnd'];

  orderedOpenIds.forEach((id) => {
    columns.push(id);
  });

  ratingIds.forEach((id) => {
    columns.push(id);
    columns.push(`${id}_followup`);
  });

  radioIds.forEach((id) => {
    columns.push(id);
  });

  return {
    columns,
    ratingIds,
    radioIds,
    openIds: orderedOpenIds
  };
}

function formatCsvValue(value) {
  const stringValue = value === undefined || value === null ? '' : String(value);
  const escaped = stringValue.replace(/"/g, '""');
  return `"${escaped}"`;
}

async function ensureCsvHeader(columns) {
  try {
    await fs.access(CSV_PATH);
  } catch {
    const headerLine = columns.map(formatCsvValue).join(',') + '\n';
    await fs.writeFile(CSV_PATH, headerLine, 'utf-8');
  }
}

function extractAnswerValue(answer, field = 'value') {
  if (answer === undefined || answer === null) {
    return '';
  }

  if (typeof answer === 'object') {
    const candidate = answer[field];
    if (candidate === undefined || candidate === null) {
      return '';
    }
    return String(candidate);
  }

  return field === 'value' ? String(answer) : '';
}

async function appendStructuredAnswersToCsv(sessionId, structuredAnswers, timestamps = {}) {
  if (!structuredAnswers || typeof structuredAnswers !== 'object') {
    return;
  }

  const questionsDefinition = await loadQuestionsDefinition();
  if (!questionsDefinition) {
    return;
  }

  const flattened = flattenQuestions(questionsDefinition);
  const { columns, ratingIds, radioIds, openIds } = buildCsvConfiguration(flattened);

  await ensureCsvHeader(columns);

  const answers = structuredAnswers.answers || {};
  const timestampStart = structuredAnswers.timestampStart || timestamps.start || '';
  const timestampEnd = structuredAnswers.timestampEnd || timestamps.end || '';

  const rowValues = [
    sessionId,
    timestampStart || '',
    timestampEnd || ''
  ];

  openIds.forEach((id) => {
    const answer = answers[id];
    rowValues.push(extractAnswerValue(answer));
  });

  ratingIds.forEach((id) => {
    const answer = answers[id];
    rowValues.push(extractAnswerValue(answer));
    rowValues.push(extractAnswerValue(answer, 'followup'));
  });

  radioIds.forEach((id) => {
    const answer = answers[id];
    rowValues.push(extractAnswerValue(answer));
  });

  const line = rowValues.map(formatCsvValue).join(',') + '\n';
  await fs.appendFile(CSV_PATH, line, 'utf-8');
}

function computeDurationMinutes(start, end) {
  if (!start || !end) {
    return 0;
  }

  const startDate = new Date(start);
  const endDate = new Date(end);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return 0;
  }

  const diff = endDate.getTime() - startDate.getTime();
  return diff > 0 ? Math.round(diff / 1000 / 60) : 0;
}

// Créer le dossier responses s'il n'existe pas
async function ensureResponsesDir() {
  try {
    await fs.access(RESPONSES_DIR);
  } catch {
    await fs.mkdir(RESPONSES_DIR, { recursive: true });
  }
}

// Endpoint principal pour le chat
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, sessionId } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages requis' });
    }

    console.log(`[${new Date().toISOString()}] Chat request for session: ${sessionId}`);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: messages,
      max_tokens: 300,        // Plus adapté pour des réponses de qualité
      temperature: 0.7,
      presence_penalty: 0.1,   // Évite les répétitions
      frequency_penalty: 0.3,  // Encourage la variété
    });

    const response = completion.choices[0].message.content;
    
    res.json({
      response: response,
      sessionId: sessionId
    });

  } catch (error) {
    console.error('Erreur OpenAI:', error);
    
    if (error.code === 'insufficient_quota') {
      res.status(402).json({ error: 'Quota API dépassé' });
    } else if (error.code === 'rate_limit_exceeded') {
      res.status(429).json({ error: 'Limite de débit atteinte' });
    } else {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
});

// Endpoint pour sauvegarder les réponses du questionnaire
app.post('/api/save-responses', async (req, res) => {
  try {
    const {
      sessionId,
      responses,
      userInfo,
      completedAt,
      timestampStart,
      timestampEnd,
      structuredAnswers
    } = req.body;

    if (!sessionId || !responses) {
      return res.status(400).json({ error: 'Session ID et réponses requis' });
    }

    await ensureResponsesDir();

    const responsesArray = Array.isArray(responses) ? responses : [];

    const inferredStart = timestampStart || (structuredAnswers && structuredAnswers.timestampStart) || (responsesArray.length > 0 ? responsesArray[0].timestamp : null);
    const inferredEnd = timestampEnd || (structuredAnswers && structuredAnswers.timestampEnd) || completedAt || (responsesArray.length > 0 ? responsesArray[responsesArray.length - 1].timestamp : null) || new Date().toISOString();

    const surveyData = {
      sessionId,
      responses: responsesArray,
      structuredAnswers: structuredAnswers || null,
      userInfo: userInfo || {},
      timestampStart: inferredStart || null,
      timestampEnd: inferredEnd,
      completedAt: inferredEnd,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      metadata: {
        totalQuestions: responsesArray.length,
        interviewDuration: computeDurationMinutes(inferredStart, inferredEnd),
        lastQuestion: responsesArray.length > 0 ? responsesArray[responsesArray.length - 1].question : null
      }
    };

    const datePrefix = new Date().toISOString().split('T')[0];
    const filename = `survey_${datePrefix}_${sessionId}.json`;
    const filepath = path.join(RESPONSES_DIR, filename);

    await fs.writeFile(filepath, JSON.stringify(surveyData, null, 2));

    console.log(`[${new Date().toISOString()}] Survey saved: ${filename}`);

    res.json({
      success: true,
      message: 'Réponses sauvegardées avec succès',
      surveyId: sessionId
    });

  } catch (error) {
    console.error('Erreur sauvegarde:', error);
    res.status(500).json({ error: 'Erreur lors de la sauvegarde' });
  }
});

// Endpoint pour récupérer les statistiques (optionnel)
app.get('/api/admin/stats', async (req, res) => {
  try {
    await ensureResponsesDir();
    const files = await fs.readdir(RESPONSES_DIR);
    const surveyFiles = files.filter(f => f.startsWith('survey_') && f.endsWith('.json'));
    
    res.json({
      totalSurveys: surveyFiles.length,
      files: surveyFiles
    });
  } catch (error) {
    console.error('Erreur stats:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des stats' });
  }
});

// Endpoint pour télécharger les réponses (optionnel)
app.get('/api/admin/download/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filepath = path.join(RESPONSES_DIR, filename);
    
    // Vérifier que le fichier existe et est un fichier de survey
    if (!filename.startsWith('survey_') || !filename.endsWith('.json')) {
      return res.status(400).json({ error: 'Fichier non autorisé' });
    }
    
    await fs.access(filepath);
    res.download(filepath);
    
  } catch (error) {
    console.error('Erreur téléchargement:', error);
    res.status(404).json({ error: 'Fichier non trouvé' });
  }
});

// Route de test
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Gestion des erreurs globales
app.use((err, req, res, next) => {
  console.error('Erreur non gérée:', err);
  res.status(500).json({ error: 'Erreur interne du serveur' });
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`🚀 Serveur chatbot démarré sur le port ${PORT}`);
  console.log(`📁 Répertoire des réponses: ${RESPONSES_DIR}`);
  ensureResponsesDir();
});

// Gestion de l'arrêt propre
process.on('SIGTERM', () => {
  console.log('🛑 Arrêt du serveur...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Arrêt du serveur...');
  process.exit(0);
});
