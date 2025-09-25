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
  origin: ['https://chat.cdafrance.eu', 'http://localhost'], // Ajustez selon vos besoins
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
    const { sessionId, responses, userInfo, completedAt } = req.body;
    
    if (!sessionId || !responses) {
      return res.status(400).json({ error: 'Session ID et réponses requis' });
    }

    await ensureResponsesDir();

    // Créer l'objet de données à sauvegarder
    const surveyData = {
      sessionId,
      responses,
      userInfo: userInfo || {},
      completedAt: completedAt || new Date().toISOString(),
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      metadata: {
        totalQuestions: responses.length,
        interviewDuration: responses.length > 0 ? 
          Math.round((new Date(completedAt) - new Date(responses[0].timestamp)) / 1000 / 60) : 0, // en minutes
        lastQuestion: responses.length > 0 ? responses[responses.length - 1].question : null
      }
    };

    // Nom du fichier basé sur la date et l'ID de session
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `survey_${timestamp}_${sessionId}.json`;
    const filepath = path.join(RESPONSES_DIR, filename);

    // Sauvegarder les données
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
