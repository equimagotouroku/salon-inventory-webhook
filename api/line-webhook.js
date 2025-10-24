// Minimal LINE webhook with health check and robust parsing

// GET: health check for browser/Verify
// POST: LINE webhook handler

const TRIGGER_WORDS = ['欲しい', 'ほしい', '発注', '注文', 'お願い', '必要', '下さい', 'ください', '至急', '緊急'];
// 制限設定（環境変数で制御）
const ALLOWED_GROUP_IDS = (process.env.ALLOWED_GROUP_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const REQUIRED_PREFIX = process.env.REQUIRED_PREFIX || '';

function normalizeText(input) {
  if (!input) return '';
  const zenkaku = input.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  return zenkaku.replace(/\u3000/g, ' ').trim();
}

function hasTrigger(text) {
  return TRIGGER_WORDS.some(w => text.includes(w));
}

function getProductUnit(productCode) {
  // ルール: カラー剤はすべて本数。指定がgのときのみgを尊重。
  const code = (productCode || '').toUpperCase();
  const colorLike = /^(\d{1,2}[A-Z]{1,3}|GR\d+|SB\d+|BE\d+|MT\d+|ASH\d+)/i.test(code);
  if (colorLike) return '本';
  // ストレート・その他は本
  return '本';
}

function detectCategory(productCode, text) {
  const t = (text || '').toLowerCase();
  const code = (productCode || '').toLowerCase();
  if (/^(\d{1,2}[a-z]{1,3})/.test(code) || /(gr|sb|be|mt|ash)/.test(code)) {
    return { category: 'color', type: 'color' };
  }
  if (/クオライン|quoline|縮毛|ストレート/.test(t)) {
    return { category: 'straightening', type: 'chemical' };
  }
  if (/トリートメント|treatment|リペア|repair/.test(t)) {
    return { category: 'treatment', type: 'treatment' };
  }
  return { category: 'other', type: 'other' };
}

// 在庫一覧（ローカルJSONから生成）
function getInventoryListFromFiles() {
  try {
    const fs = require('fs');
    const path = require('path');
    const candidates = [
      path.join(__dirname, '..', 'data'),
      path.join(__dirname, '..', '..', 'apps', 'Hair-Color-AI-Complete-Lab-System-20250127', 'data')
    ];

    let dataDir = null;
    for (const p of candidates) {
      if (fs.existsSync(path.join(p, 'products.json')) && fs.existsSync(path.join(p, 'stock.json'))) {
        dataDir = p; break;
      }
    }
    if (!dataDir) return null;

    const products = JSON.parse(fs.readFileSync(path.join(dataDir, 'products.json'), 'utf8'));
    const stock = JSON.parse(fs.readFileSync(path.join(dataDir, 'stock.json'), 'utf8'));
    const qtyById = new Map(stock.map(s => [s.productId, s.qty]));

    const order = ['color', 'straightening', 'treatment', 'perm', 'styling', 'other'];
    const label = {
      color: '【カラー剤】',
      straightening: '【縮毛矯正（ストレート）】',
      treatment: '【トリートメント】',
      perm: '【パーマ剤】',
      styling: '【スタイリング】',
      other: '【その他】'
    };

    let lines = ['📦 在庫一覧', ''];
    for (const cat of order) {
      const items = products.filter(p => (p.category || 'other') === cat);
      if (items.length === 0) continue;
      lines.push(label[cat] || label.other);
      for (const p of items) {
        const q = qtyById.get(p.id) ?? 0;
        const rp = p.reorderPoint ?? 0;
        const status = q === 0 ? '🔴 在庫切れ' : q < rp ? '🟡 少ない' : '🟢 十分';
        lines.push(`・${p.brand ? p.brand + ' ' : ''}${p.id}${p.name && p.name !== p.id ? ' ' + p.name : ''}: ${q}${p.unit || ''} ${status}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  } catch (e) {
    console.error('inventory list (files) error', e);
    return null;
  }
}

function parseInventoryRequest(input) {
  const raw = input || '';
  const text = normalizeText(raw);
  if (!hasTrigger(text)) return null;

  // 例: 5NN 2本 欲しい / 5NN2本 / 5NN 2 ほしい
  let m = text.match(/([A-Z0-9]{2,})\s*(\d+)\s*(本|個|g|グラム)?/i);
  if (m) {
    const productCode = m[1].toUpperCase();
    const quantity = parseInt(m[2]);
    const specified = m[3];
    const standard = getProductUnit(productCode);
    const unit = specified ? (/g|グラム/i.test(specified) ? 'g' : '本') : standard;
    return {
      productCode,
      quantity,
      unit,
      originalText: raw,
      priority: /至急|緊急/.test(text) ? 'urgent' : 'normal',
    };
  }

  // 例: クオライン80 3本 お願い
  m = text.match(/(クオライン|QuoLine|quoline)\s*(\d+)\s*(\d+)\s*(本|個)?/i);
  if (m) {
    return {
      productCode: `${m[1]}_${m[2]}`,
      quantity: parseInt(m[3]),
      unit: '本',
      originalText: raw,
      priority: /至急|緊急/.test(text) ? 'urgent' : 'normal',
    };
  }

  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Line-Signature');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, route: '/api/line-webhook', time: new Date().toISOString() });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const body = req.body || {};
    if (!Array.isArray(body.events)) return res.status(200).json({ ok: true });

    for (const event of body.events) {
      if (event.type === 'message' && event.message?.type === 'text') {
        const text = event.message.text || '';
        // 社内専用ガード: 許可したグループ/ルーム、必要ならプレフィックス必須
        const isGroup = event.source?.type === 'group' || event.source?.type === 'room';
        const groupId = event.source?.groupId || event.source?.roomId || '';
        if (!isGroup) {
          // 1:1トークでは反応しない
          continue;
        }
        if (ALLOWED_GROUP_IDS.length && !ALLOWED_GROUP_IDS.includes(groupId)) {
          continue;
        }
        if (REQUIRED_PREFIX && !normalizeText(text).startsWith(normalizeText(REQUIRED_PREFIX))) {
          continue;
        }
        const strippedText = REQUIRED_PREFIX ? text.replace(new RegExp('^' + REQUIRED_PREFIX), '') : text;
        let replyMessage;

        if (strippedText === 'ヘルプ' || strippedText.toLowerCase() === 'help') {
          replyMessage = {
            type: 'text',
            text: '📦 在庫管理BOT\n\n【在庫リクエスト例】\n・5NN 2本 欲しい\n・GR13 1本 欲しい\n・クオライン80 3本 お願い\n\n【ヒント】数字やスペースが全角でもOK',
          };
        } else if (strippedText === '在庫一覧') {
          const textList = getInventoryListFromFiles();
          replyMessage = {
            type: 'text',
            text: textList || '📦 在庫一覧を取得できませんでした（設定ファイル未配置の可能性）',
          };
        } else {
          const req = parseInventoryRequest(strippedText);
          if (req) {
            const cat = detectCategory(req.productCode, strippedText);
            const id = `req_${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0,14)}`;
            console.log('REQUEST', { id, ...req, cat });
            replyMessage = {
              type: 'text',
              text: `✅ 在庫リクエストを受け付けました！\n\nリクエストID: ${id}\n商品: ${req.productCode}\n数量: ${req.quantity}${req.unit}\nカテゴリー: ${cat.category}`,
            };
          } else if (hasTrigger(strippedText)) {
            replyMessage = {
              type: 'text',
              text: '⚠️ 形式が認識できませんでした。\n例: 5NN 2本 欲しい / GR13 1本 欲しい / クオライン80 3本 お願い',
            };
          } else {
            replyMessage = { type: 'text', text: 'こんにちは！\n「ヘルプ」と送信すると使い方が表示されます。' };
          }
        }

        if (replyMessage && token) {
          const resp = await fetch('https://api.line.me/v2/bot/message/reply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ replyToken: event.replyToken, messages: [replyMessage] }),
          });
          console.log('LINE reply', resp.status);
        }
      }
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};


