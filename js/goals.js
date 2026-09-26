// goals: daily nutrition targets, and checking the week's plan against them.
// No HTML here.
//
// Saved data (see README "Data model"):
//   nutritionGoals - one per nutrient the user set: { nutrient, min, max }
//                    min = "at least", max = "at most"; either can be empty (null).
const goals = (() => {
  // All goals as { kcal: { min, max }, protein: {...}, ... } (only the ones set).
  function getGoals() {
    return Object.fromEntries(store.list("nutritionGoals").map((g) => [g.nutrient, { min: g.min, max: g.max }]));
  }

  // Saves the goal for one nutrient. Returns an error message, or null.
  // Leaving both empty removes the goal.
  function setGoal(nutrient, min, max) {
    if (!NUTRIENTS.some((n) => n.key === nutrient)) return "Unknown nutrient.";
    if ([min, max].some((v) => v !== null && !(v >= 0))) return "Goals must be numbers of 0 or more.";
    if (min !== null && max !== null && min > max) return "“At least” can't be more than “at most”.";
    store.removeWhere("nutritionGoals", (g) => g.nutrient === nutrient);
    if (min !== null || max !== null) store.insert("nutritionGoals", { nutrient, min, max });
    return null;
  }

  // Compares one day's amount with a goal:
  //   "under" - below "at least"   "over" - above "at most"   "ok" - in range
  function check(value, goal) {
    if (goal.min !== null && value < goal.min) return "under";
    if (goal.max !== null && value > goal.max) return "over";
    return "ok";
  }

  // The week's plan against the goals. Returns:
  //   { goalKeys, days: [{ day, planned, incomplete, checks: [{ key, value, goal, status }] }],
  //     averages: [{ key, value, goal, status }], plannedDays, daysOnTarget }
  // Days with nothing planned aren't judged. Averages are over planned days only.
  function reviewWeek(weekStart) {
    const allGoals = getGoals();
    const goalKeys = NUTRIENTS.map((n) => n.key).filter((key) => allGoals[key]);
    const items = mealPlans.listItems(weekStart);
    const week = nutrition.forWeek(weekStart);

    const days = week.days.map(({ day, nutrients, missingRecipes }) => {
      const planned = items.some((item) => item.day === day);
      return {
        day,
        planned,
        incomplete: missingRecipes.length > 0,
        missingRecipes,
        checks: goalKeys.map((key) => ({ key, value: nutrients[key], goal: allGoals[key],
          status: planned ? check(nutrients[key], allGoals[key]) : null })),
      };
    });

    const plannedDays = days.filter((d) => d.planned);
    const averages = goalKeys.map((key) => {
      const total = plannedDays.reduce((sum, d) => sum + d.checks.find((c) => c.key === key).value, 0);
      const value = plannedDays.length ? total / plannedDays.length : 0;
      return { key, value, goal: allGoals[key], status: plannedDays.length ? check(value, allGoals[key]) : null };
    });

    return {
      goalKeys,
      days,
      averages,
      plannedDays: plannedDays.length,
      daysOnTarget: plannedDays.filter((d) => d.checks.every((c) => c.status === "ok")).length,
    };
  }

  return { getGoals, setGoal, check, reviewWeek };
})();
