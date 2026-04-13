/**
 * game-engine.js
 * InsuLife（インシュライフ）— 共通ゲームロジック
 *
 * 依存: なし（純粋な関数群。データはすべて引数で受け取る）
 * 利用側でJSON読み込み後に各関数へ渡すこと。
 */

"use strict";

// ─────────────────────────────────────────────────────────────
// 1. ゲーム初期化
// ─────────────────────────────────────────────────────────────

/**
 * ゲームセッションを初期化する。
 * @param {object} params
 * @param {string}   params.lifestyleId      - 選択されたライフスタイルID
 * @param {string[]} params.playerIds        - プレイヤーID一覧
 * @param {object}   params.lifestylesData   - lifestyles.json の内容
 * @param {object}   params.stagesData       - stages.json の内容
 * @returns {object} gameState
 */
function initGame({ lifestyleId, playerIds, lifestylesData, stagesData }) {
  const lifestyle = lifestylesData.lifestyles.find(l => l.id === lifestyleId);
  if (!lifestyle) throw new Error(`ライフスタイルが見つかりません: ${lifestyleId}`);

  const players = playerIds.map(id => ({
    id,
    assets: lifestyle.initialAssets,   // 万円
    insurances: [],                    // { insuranceId, monthlyPremium, enrolledAtStop }
    goals: [],                         // { goalId, monthlySpend } (強制ストップ後に設定)
    turnHistory: [],                   // ターン記録
  }));

  return {
    lifestyle,
    players,
    currentStageIndex: 0,
    currentTurnInStage: 0,
    globalTurn: 0,
    phase: "mandatoryStop",            // "mandatoryStop" | "turn" | "gameOver"
    log: [],
  };
}

// ─────────────────────────────────────────────────────────────
// 2. プレイヤー個人設定（強制ストップ時に呼ぶ）
// ─────────────────────────────────────────────────────────────

/**
 * プレイヤーの目的カードを設定する（ゲーム開始時の強制ストップで呼ぶ）。
 * @param {object} player
 * @param {Array<{goalId: string, monthlySpend: number}>} goalSelections
 * @param {object} goalsData - goals.json の内容
 */
function setPlayerGoals(player, goalSelections, goalsData) {
  if (goalSelections.length < 2) {
    throw new Error("目的カードは最低2枚選択してください。");
  }
  player.goals = goalSelections.map(sel => {
    const goal = goalsData.goalCards.find(g => g.id === sel.goalId);
    if (!goal) throw new Error(`目的カードが見つかりません: ${sel.goalId}`);
    const { minRate, maxRate } = goalsData.spendingAdjustmentRange;
    const spend = sel.monthlySpend ?? goal.defaultMonthlySpend;
    const min = Math.floor(goal.defaultMonthlySpend * minRate);
    const max = Math.floor(goal.defaultMonthlySpend * maxRate);
    if (goal.hasRecurringCost && (spend < min || spend > max)) {
      throw new Error(`月次支出が範囲外です (${min}〜${max}円): ${sel.goalId}`);
    }
    return { goalId: sel.goalId, monthlySpend: spend };
  });
}

/**
 * プレイヤーの保険加入/解約を処理する（強制ストップ時に呼ぶ）。
 * @param {object} player
 * @param {string[]} insuranceIdsToAdd    - 新規加入する保険IDリスト
 * @param {string[]} insuranceIdsToCancle - 解約する保険IDリスト
 * @param {string}   stopId               - 現在の強制ストップID
 * @param {object}   insuranceData        - insurance.json の内容
 * @param {object}   stagesData           - stages.json の内容
 */
function reviewInsurance(player, insuranceIdsToAdd, insuranceIdsToCancle, stopId, insuranceData, stagesData) {
  // 解約
  player.insurances = player.insurances.filter(i => !insuranceIdsToCancle.includes(i.insuranceId));

  // 加入
  const multiplierEntry = insuranceData.timingMultipliers.find(t => t.stopId === stopId);
  if (!multiplierEntry) throw new Error(`タイミング乗数が見つかりません: ${stopId}`);
  const multiplier = multiplierEntry.multiplier;

  for (const insId of insuranceIdsToAdd) {
    if (player.insurances.some(i => i.insuranceId === insId)) continue; // 既加入はスキップ
    const ins = insuranceData.insuranceTypes.find(i => i.id === insId);
    if (!ins) throw new Error(`保険が見つかりません: ${insId}`);

    // minEnrollmentStop チェック（介護保険は結婚以降から加入可能）
    if (ins.minEnrollmentStop) {
      const minStop = insuranceData.timingMultipliers.find(t => t.stopId === ins.minEnrollmentStop);
      if (minStop && multiplierEntry.multiplier < minStop.multiplier) {
        throw new Error(`${ins.name}は${minStop.stopName}以降から加入できます。`);
      }
    }

    // maxEnrollmentStop チェック
    if (ins.maxEnrollmentStop) {
      const maxStop = insuranceData.timingMultipliers.find(t => t.stopId === ins.maxEnrollmentStop);
      if (maxStop && multiplierEntry.multiplier > maxStop.multiplier) {
        throw new Error(`${ins.name}はこのタイミングでは加入できません。`);
      }
    }

    const monthlyPremium = Math.round(ins.baseMonthlyPremium * multiplier);
    const record = { insuranceId: insId, monthlyPremium, enrolledAtStop: stopId };

    // 個人年金: 加入タイミング別の受取額を確定して記録
    if (insId === "personalPension" && ins.pensionBonusByStop) {
      record.additionalMonthlyIncome = ins.pensionBonusByStop[stopId] ?? ins.additionalMonthlyIncome ?? 0;
    }

    // 終身保険: 加入タイミング別の死亡保険金額を確定して記録
    if (insId === "wholeLife" && ins.deathBenefitByStop) {
      record.deathBenefit = ins.deathBenefitByStop[stopId] ?? 0;
    }

    player.insurances.push(record);
  }
}

// ─────────────────────────────────────────────────────────────
// 3. イベント抽選
// ─────────────────────────────────────────────────────────────

/**
 * 現在のステージの確率テーブルからイベントカテゴリを抽選する。
 * @param {object} lifestyle  - lifestyles.json 内の1ライフスタイル
 * @param {string} stageId    - 現在のステージID ("stage1"〜"stage6")
 * @param {Function} [rng]    - 0〜1の乱数を返す関数 (省略時は Math.random)
 * @returns {string} カテゴリID ("medical"|"accident"|"disability"|"care"|"asset"|"lucky")
 */
function rollEventCategory(lifestyle, stageId, rng = Math.random) {
  const probs = lifestyle.stageProbabilities[stageId];
  if (!probs) throw new Error(`ステージが見つかりません: ${stageId}`);

  const roll = rng() * 100;
  let cumulative = 0;
  const order = ["medical", "accident", "disability", "care", "asset", "lucky"];
  for (const category of order) {
    cumulative += probs[category] ?? 0;
    if (roll < cumulative) return category;
  }
  return "lucky"; // 丸め誤差フォールバック
}

/**
 * カテゴリとステージからイベントカードを抽選する。
 * severity は重みつきランダム（light:3, medium:2, heavy:1）。
 * @param {string}   category   - イベントカテゴリ
 * @param {string}   stageId    - 現在のステージID
 * @param {object}   eventsData - events.json の内容
 * @param {Function} [rng]
 * @returns {object} イベントカード
 */
function drawEventCard(category, stageId, eventsData, rng = Math.random) {
  const candidates = eventsData.events.filter(ev =>
    ev.category === category &&
    (ev.availableStages === null || ev.availableStages.includes(stageId))
  );
  if (candidates.length === 0) {
    // フォールバック: ステージ制限なしから選ぶ
    const fallback = eventsData.events.filter(ev => ev.category === category);
    return fallback[Math.floor(rng() * fallback.length)];
  }

  // severity 重みつき抽選
  const weights = { light: 3, medium: 2, heavy: 1 };
  const pool = candidates.flatMap(ev => Array(weights[ev.severity] ?? 1).fill(ev));
  return pool[Math.floor(rng() * pool.length)];
}

// ─────────────────────────────────────────────────────────────
// 4. 1ターン処理
// ─────────────────────────────────────────────────────────────

/**
 * 年間収入を計算する（万円）。
 * personalPension 保険加入者は老後期(stage5以降)に追加収入あり。
 * @param {object} player
 * @param {object} stage        - stages.json 内の1ステージ
 * @param {object} insuranceData
 * @returns {number} 年間収入（万円）
 */
function calculateAnnualIncome(player, stage, insuranceData) {
  let monthly = stage.monthlyIncome; // 円

  // 個人年金: player の insurance record に記録された受取額を使う（加入時期で異なる）
  const pensionRecord = player.insurances.find(i => i.insuranceId === "personalPension");
  if (pensionRecord && ["stage5", "stage6"].includes(stage.id)) {
    monthly += pensionRecord.additionalMonthlyIncome ?? 0;
  }

  return (monthly * 12) / 10000; // 円→万円
}

/**
 * 年間基礎生活費を返す（万円）。
 * stages.json の annualBasicExpense フィールドをそのまま使用。
 * @param {object} stage
 * @returns {number} 年間基礎生活費（万円）
 */
function calculateAnnualBasicExpense(stage) {
  return stage.annualBasicExpense ?? 0; // 万円
}

/**
 * 年間保険料合計を計算する（万円）。
 * @param {object} player
 * @returns {number} 年間保険料（万円）
 */
function calculateAnnualPremium(player) {
  const monthlyTotal = player.insurances.reduce((sum, i) => sum + i.monthlyPremium, 0);
  return (monthlyTotal * 12) / 10000; // 円→万円
}

/**
 * 目的カードの年間支出合計を計算する（アクティブなステージのみ）。
 * @param {object} player
 * @param {string} stageId
 * @param {object} goalsData
 * @returns {number} 年間目的支出（万円）
 */
function calculateAnnualGoalSpend(player, stageId, goalsData) {
  let monthlyTotal = 0;
  for (const pg of player.goals) {
    const goal = goalsData.goalCards.find(g => g.id === pg.goalId);
    if (goal && goal.hasRecurringCost && goal.activeStages.includes(stageId)) {
      monthlyTotal += pg.monthlySpend;
    }
  }
  return (monthlyTotal * 12) / 10000; // 円→万円
}

/**
 * ステージに応じたイベントの金額を返す（万円）。
 * stageAmounts にそのステージのエントリがあればそれを優先し、なければ amount を使う。
 * @param {object} eventCard - イベントカード
 * @param {string} stageId   - 現在のステージID
 * @returns {number} 金額（万円。負=損失、正=利益）
 */
function getEventAmount(eventCard, stageId) {
  if (eventCard.stageAmounts && eventCard.stageAmounts[stageId] !== undefined) {
    return eventCard.stageAmounts[stageId];
  }
  return eventCard.amount;
}

/**
 * イベントの損失に対して保険を適用し、実際の損失額を計算する。
 * @param {number}   baseDamage  - イベントの基礎損失額（万円、正の値）
 * @param {string}   category    - イベントカテゴリ
 * @param {boolean}  isCancer    - がんイベントかどうか
 * @param {object}   player
 * @param {object}   insuranceData
 * @returns {{ actualDamage: number, totalReductionRate: number }}
 */
function applyInsuranceToEvent(baseDamage, category, isCancer, player, insuranceData) {
  // カテゴリに対応する保険を収集
  const applicableIns = player.insurances
    .map(pi => insuranceData.insuranceTypes.find(i => i.id === pi.insuranceId))
    .filter(ins => {
      if (!ins || !ins.coverageCategories.includes(category)) return false;
      if (ins.coverageCondition === "cancer_only" && !isCancer) return false;
      return true;
    });

  if (applicableIns.length === 0) {
    return { actualDamage: baseDamage, totalReductionRate: 0 };
  }

  // 最も高い combinedReductionCap を使う
  const cap = Math.max(...applicableIns.map(i => i.combinedReductionCap));

  // 各保険の軽減率を合算（上限でクリップ）
  let totalRate = applicableIns.reduce((sum, ins) => sum + ins.reductionRate, 0);
  totalRate = Math.min(totalRate, cap);

  const actualDamage = Math.round(baseDamage * (1 - totalRate));
  return { actualDamage, totalReductionRate: totalRate };
}

/**
 * 1ターンを処理し、全プレイヤーの資産を更新する。
 * @param {object} gameState
 * @param {object} stagesData
 * @param {object} eventsData
 * @param {object} goalsData
 * @param {object} insuranceData
 * @param {Function} [rng]
 * @returns {{ eventCard: object, playerResults: Array }} ターン結果
 */
function processTurn(gameState, stagesData, eventsData, goalsData, insuranceData, rng = Math.random) {
  const stage = stagesData.stages[gameState.currentStageIndex];

  // イベント抽選（全員共通）
  const category = rollEventCategory(gameState.lifestyle, stage.id, rng);
  const eventCard = drawEventCard(category, stage.id, eventsData, rng);

  const years = stage.yearsPerTurn ?? 1; // 経過年数

  const playerResults = gameState.players.map(player => {
    // 年額 × 経過年数（複数年分まとめて計算）
    const annualIncome      = calculateAnnualIncome(player, stage, insuranceData);
    const annualBasicExpense = calculateAnnualBasicExpense(stage);
    const annualPremium     = calculateAnnualPremium(player);
    const annualGoalSpend   = calculateAnnualGoalSpend(player, stage.id, goalsData);

    const income      = annualIncome      * years;
    const basicExpense = annualBasicExpense * years;
    const premium     = annualPremium     * years;
    const goalSpend   = annualGoalSpend   * years;

    // イベント損失は一時発生額（経過年数乗算なし）
    const effectiveEventAmount = getEventAmount(eventCard, stage.id);
    let eventDamage = 0;
    let reductionRate = 0;
    if (effectiveEventAmount < 0) {
      const base = Math.abs(effectiveEventAmount);
      const result = applyInsuranceToEvent(base, category, eventCard.isCancerEvent, player, insuranceData);
      eventDamage = result.actualDamage;
      reductionRate = result.totalReductionRate;
    }

    // ラッキーイベントは一時ゲイン（経過年数乗算なし）
    const eventGain = effectiveEventAmount > 0 ? effectiveEventAmount : 0;

    // 資産変動 = 収入 - 基礎生活費 - 保険料 - 目的支出 - イベント損失 + ラッキーゲイン
    const netChange = income - basicExpense - premium - goalSpend - eventDamage + eventGain;
    player.assets = Math.round((player.assets + netChange) * 10) / 10;

    const record = {
      turn: gameState.globalTurn + 1,
      stageId: stage.id,
      years,
      annualIncome,
      annualBasicExpense,
      annualPremium,
      annualGoalSpend,
      income,
      basicExpense,
      premium,
      goalSpend,
      eventCard,
      eventDamage,
      reductionRate,
      eventGain,
      netChange,
      assetsAfter: player.assets,
    };
    player.turnHistory.push(record);
    return { playerId: player.id, ...record };
  });

  // ステートを進める
  gameState.globalTurn += 1;
  gameState.currentTurnInStage += 1;
  gameState.log.push({ type: "turn", globalTurn: gameState.globalTurn, eventCard, playerResults });

  // ステージ終了判定
  if (gameState.currentTurnInStage >= stage.turns) {
    const nextStageIndex = gameState.currentStageIndex + 1;
    if (nextStageIndex >= stagesData.stages.length) {
      gameState.phase = "gameOver";
      // ゲーム終了時: 終身保険の死亡保険金を全プレイヤーの資産に加算
      gameState.players.forEach(p => {
        const wholeLifeRecord = p.insurances.find(i => i.insuranceId === "wholeLife");
        if (wholeLifeRecord && wholeLifeRecord.deathBenefit > 0) {
          p.assets = Math.round((p.assets + wholeLifeRecord.deathBenefit) * 10) / 10;
          gameState.log.push({ type: "deathBenefit", playerId: p.id, amount: wholeLifeRecord.deathBenefit });
        }
      });
    } else {
      gameState.currentStageIndex = nextStageIndex;
      gameState.currentTurnInStage = 0;
      gameState.phase = "mandatoryStop";
    }
  }

  return { eventCard, playerResults };
}

// ─────────────────────────────────────────────────────────────
// 5. 強制ストップ完了処理
// ─────────────────────────────────────────────────────────────

/**
 * 強制ストップ処理を完了し、ターンフェーズへ移行する。
 * insurance review は reviewInsurance() を先に呼ぶこと。
 * @param {object} gameState
 */
function completeMandatoryStop(gameState) {
  gameState.phase = "turn";
  gameState.log.push({ type: "mandatoryStop", stageIndex: gameState.currentStageIndex });
}

// ─────────────────────────────────────────────────────────────
// 6. 終了処理・スコア計算
// ─────────────────────────────────────────────────────────────

/**
 * ゲーム終了時に各プレイヤーのゴール達成状況を評価する。
 * @param {object} player
 * @param {object} goalsData
 * @param {object} insuranceData
 * @param {object} stagesData
 * @returns {object} goalResults
 */
function evaluateGoals(player, goalsData, insuranceData, stagesData) {
  const allStageIds = stagesData.stages.map(s => s.id);
  const goalResults = player.goals.map(pg => {
    const goal = goalsData.goalCards.find(g => g.id === pg.goalId);

    // タイプB・Cの保険達成条件チェック
    let insuranceAchieved = true;
    if (goal.requiredInsurance.length > 0) {
      insuranceAchieved = goal.requiredInsurance.some(reqIns =>
        player.insurances.some(pi => pi.insuranceId === reqIns)
      );
    }

    // タイプA・Cの支出継続チェック
    // 目的カードのactiveStagesで、全ターン赤字にならずに支出できたかを history から検証
    let spendAchieved = true;
    if (goal.hasRecurringCost && goal.activeStages.length > 0) {
      const activeHistory = player.turnHistory.filter(h => goal.activeStages.includes(h.stageId));
      // 支出すべきターン数と実際に支出できたターン数（資産がマイナスでも支出はしたとみなす）
      const requiredTurns = activeHistory.length;
      const actualTurns = activeHistory.filter(h => h.goalSpend > 0).length;
      if (requiredTurns > 0 && actualTurns < requiredTurns) {
        spendAchieved = false;
      }
    }

    // 達成レベル判定
    let level;
    const typeA = goal.type === "A";
    const typeB = goal.type === "B";
    const typeC = goal.type === "C";

    if (typeA) {
      level = spendAchieved ? "achieved" : "notAchieved";
    } else if (typeB) {
      level = insuranceAchieved ? "achieved" : "notAchieved";
    } else {
      // TypeC: 両方必要
      if (spendAchieved && insuranceAchieved) level = "achieved";
      else if (spendAchieved || insuranceAchieved) level = "partialAchieved";
      else level = "notAchieved";
    }

    const scoreWeight = goalsData.achievementLevels[level].scoreWeight;
    return { goalId: pg.goalId, title: goal.title, level, scoreWeight };
  });

  return goalResults;
}

/**
 * 最終スコアを計算する。
 * スコア = 達成率スコア（達成枚数÷選択枚数×100）+ 達成枚数ボーナス（達成枚数×10）
 * @param {object} player
 * @param {object} goalsData
 * @param {object} insuranceData
 * @param {object} stagesData
 * @returns {object} { goalResults, achievedCount, totalCount, achievementRate, bonusScore, totalScore, finalAssets }
 */
function calculateFinalScore(player, goalsData, insuranceData, stagesData) {
  const goalResults = evaluateGoals(player, goalsData, insuranceData, stagesData);

  const totalCount = goalResults.length;
  const achievedCount = goalResults.filter(r => r.level === "achieved").length;
  const partialCount = goalResults.filter(r => r.level === "partialAchieved").length;

  // 達成率（達成=1.0、一部達成=0.5として加重平均）
  const weightedSum = goalResults.reduce((sum, r) => sum + r.scoreWeight, 0);
  const achievementRate = totalCount > 0 ? (weightedSum / totalCount) * 100 : 0;

  const bonusScore = achievedCount * 10;
  const totalScore = Math.round(achievementRate + bonusScore);

  return {
    goalResults,
    achievedCount,
    partialCount,
    totalCount,
    achievementRate: Math.round(achievementRate * 10) / 10,
    bonusScore,
    totalScore,
    finalAssets: player.assets,
    isAssetNegative: player.assets < 0,
  };
}

/**
 * 全プレイヤーのスコアを計算し、ランキングを返す。
 * @param {object} gameState
 * @param {object} goalsData
 * @param {object} insuranceData
 * @param {object} stagesData
 * @returns {Array} プレイヤースコア（降順ソート済み）
 */
function calculateAllScores(gameState, goalsData, insuranceData, stagesData) {
  const scores = gameState.players.map(player => ({
    playerId: player.id,
    ...calculateFinalScore(player, goalsData, insuranceData, stagesData),
  }));

  scores.sort((a, b) => b.totalScore - a.totalScore);
  return scores;
}

// ─────────────────────────────────────────────────────────────
// 7. ユーティリティ
// ─────────────────────────────────────────────────────────────

/**
 * 現在の強制ストップIDを取得する。
 * @param {object} gameState
 * @param {object} stagesData
 * @returns {string} stopId
 */
function getCurrentStopId(gameState, stagesData) {
  const stage = stagesData.stages[gameState.currentStageIndex];
  return stage.mandatoryStopBefore.stopId;
}

/**
 * 現在のステージオブジェクトを取得する。
 * @param {object} gameState
 * @param {object} stagesData
 * @returns {object} stage
 */
function getCurrentStage(gameState, stagesData) {
  return stagesData.stages[gameState.currentStageIndex];
}

/**
 * プレイヤーの月次保険料合計を返す（表示用）。
 * @param {object} player
 * @returns {number} 月次保険料合計（円）
 */
function getMonthlyPremiumTotal(player) {
  return player.insurances.reduce((sum, i) => sum + i.monthlyPremium, 0);
}

/**
 * 保険加入時のプレミアム（月額）を計算する（加入前に確認表示する用）。
 * @param {string} insuranceId
 * @param {string} stopId
 * @param {object} insuranceData
 * @returns {number} 月額保険料（円）
 */
function previewPremium(insuranceId, stopId, insuranceData) {
  const ins = insuranceData.insuranceTypes.find(i => i.id === insuranceId);
  const mult = insuranceData.timingMultipliers.find(t => t.stopId === stopId);
  if (!ins || !mult) return 0;
  return Math.round(ins.baseMonthlyPremium * mult.multiplier);
}

/**
 * 強制ストップの任意一時費用を支払う。
 * @param {object} player
 * @param {number} amount - 支払額（万円）
 */
function payOptionalCost(player, amount) {
  player.assets = Math.round((player.assets - amount) * 10) / 10;
}

// ─────────────────────────────────────────────────────────────
// エクスポート（ブラウザ / Node.js 両対応）
// ─────────────────────────────────────────────────────────────
const GameEngine = {
  initGame,
  setPlayerGoals,
  reviewInsurance,
  completeMandatoryStop,
  rollEventCategory,
  drawEventCard,
  processTurn,
  calculateAnnualIncome,
  calculateAnnualBasicExpense,
  calculateAnnualPremium,
  calculateAnnualGoalSpend,
  applyInsuranceToEvent,
  evaluateGoals,
  calculateFinalScore,
  calculateAllScores,
  getCurrentStopId,
  getCurrentStage,
  getMonthlyPremiumTotal,
  previewPremium,
  payOptionalCost,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = GameEngine;
} else if (typeof window !== "undefined") {
  window.GameEngine = GameEngine;
}
