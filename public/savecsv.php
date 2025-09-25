<?php
header('Content-Type: application/json');

function respond($status, $payload) {
    http_response_code($status);
    echo json_encode($payload);
    exit;
}

$input = file_get_contents('php://input');
if ($input === false) {
    respond(400, ['error' => 'Aucune donnée reçue']);
}

$data = json_decode($input, true);
if ($data === null) {
    respond(400, ['error' => 'Format JSON invalide']);
}

$sessionId = isset($data['sessionId']) ? (string)$data['sessionId'] : '';
$structuredAnswers = isset($data['structuredAnswers']) && is_array($data['structuredAnswers']) ? $data['structuredAnswers'] : [];
$answers = isset($structuredAnswers['answers']) && is_array($structuredAnswers['answers']) ? $structuredAnswers['answers'] : [];
$timestampStart = isset($data['timestampStart']) ? $data['timestampStart'] : ($structuredAnswers['timestampStart'] ?? '');
$timestampEnd = isset($data['timestampEnd']) ? $data['timestampEnd'] : ($structuredAnswers['timestampEnd'] ?? '');

$questionsPath = __DIR__ . '/questions.json';
$questionsContent = @file_get_contents($questionsPath);
if ($questionsContent === false) {
    respond(500, ['error' => 'Impossible de charger questions.json']);
}

$questionsData = json_decode($questionsContent, true);
if (!is_array($questionsData) || !isset($questionsData['sections']) || !is_array($questionsData['sections'])) {
    respond(500, ['error' => 'questions.json invalide']);
}

$openIds = [];
$ratingIds = [];
$radioIds = [];

foreach ($questionsData['sections'] as $section) {
    if (!isset($section['questions']) || !is_array($section['questions'])) {
        continue;
    }
    foreach ($section['questions'] as $question) {
        if (!isset($question['id'], $question['type'])) {
            continue;
        }
        switch ($question['type']) {
            case 'open':
                $openIds[] = $question['id'];
                break;
            case 'rating':
                $ratingIds[] = $question['id'];
                break;
            case 'radio':
                $radioIds[] = $question['id'];
                break;
        }
    }
}

function formatCsvValue($value) {
    if ($value === null) {
        $value = '';
    }
    $string = (string)$value;
    $string = str_replace("\"", "\"\"", $string);
    return '"' . $string . '"';
}
function extractAnswer($answers, $key, $field = 'value') {
    if (!isset($answers[$key])) {
        return '';
    }
    $answer = $answers[$key];
    if (is_array($answer)) {
        return $answer[$field] ?? '';
    }
    return $field === 'value' ? $answer : '';
}

function decodeOpenText($value) {
    $string = (string)$value;
    return $string === '' ? '' : utf8_decode($string);
}

$row = [
    formatCsvValue($sessionId),
    formatCsvValue($timestampStart),
    formatCsvValue($timestampEnd)
];

foreach ($openIds as $id) {
    $value = decodeOpenText(extractAnswer($answers, $id, 'value'));
    $followup = decodeOpenText(extractAnswer($answers, $id, 'followup'));
    $row[] = formatCsvValue($value);
    $row[] = formatCsvValue($followup);
}
foreach ($ratingIds as $id) {
    $row[] = formatCsvValue(extractAnswer($answers, $id, 'value'));
}
foreach ($radioIds as $id) {
    $row[] = formatCsvValue(extractAnswer($answers, $id, 'value'));
}

$csvFile = __DIR__ . '/questionnaire_qvt_responses.csv';
$line = implode(',', $row) . "\n";

if (@file_put_contents($csvFile, $line, FILE_APPEND | LOCK_EX) === false) {
    respond(500, ['error' => 'Écriture du CSV impossible']);
}

respond(200, ['success' => true]);
