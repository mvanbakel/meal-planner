// categories: which aisle/section of the store an ingredient is in.
//
// The app guesses from the ingredient's name, and the user can change it.
// A user's choice is saved on the Ingredient and always wins over the guess.
const CATEGORIES = ["Produce", "Meat", "Dairy", "Pantry", "Frozen", "Other"];

// Words that point to a category, checked IN THIS ORDER. Order matters:
//   "frozen peas"   -> Frozen (checked before Produce)
//   "garlic powder" -> Pantry, because "powder" is checked before "garlic"
//   "chicken broth" -> Pantry, because "broth" is checked before "chicken"
//   "black pepper"  -> Pantry, because the phrase is checked before "pepper"
const CATEGORY_KEYWORDS = [
  ["Frozen", ["frozen", "ice cream"]],
  ["Pantry", [
    "black pepper", "peanut butter", "coconut milk", "broth", "stock", "powder", "sauce",
    "salsa", "paste", "canned", "dried", "juice", "oil", "vinegar", "seasoning", "spice",
    "flour", "sugar", "salt", "honey", "syrup", "ketchup", "mustard", "mayo", "mayonnaise",
    "cinnamon", "cumin", "paprika", "oregano", "thyme", "chili flakes", "baking soda", "baking powder",
  ]],
  ["Meat", [
    "chicken", "beef", "pork", "turkey", "bacon", "sausage", "ham", "lamb", "steak", "veal",
    "fish", "salmon", "tuna", "cod", "tilapia", "shrimp", "prawn",
  ]],
  ["Dairy", ["milk", "cheese", "cheddar", "mozzarella", "parmesan", "feta", "yogurt", "yoghurt",
    "butter", "cream", "egg", "eggs"]],
  ["Produce", [
    "pepper", "onion", "garlic", "tomato", "lettuce", "spinach", "kale", "carrot", "potato",
    "apple", "banana", "lime", "lemon", "orange", "berries", "cilantro", "parsley", "basil",
    "avocado", "broccoli", "cauliflower", "cucumber", "mushroom", "zucchini", "celery",
    "ginger", "corn", "squash", "cabbage", "green beans", "peas", "scallion", "green onion",
  ]],
  ["Pantry", [
    "rice", "pasta", "penne", "spaghetti", "noodle", "beans", "lentils", "chickpeas", "oats",
    "quinoa", "tortilla", "bread", "cereal", "nuts", "almonds", "cans",
  ]],
];

// Guesses a category from an ingredient name. Returns "Other" if unsure.
function guessCategory(name) {
  // Pad with spaces and match whole words, so "ham" doesn't match "champagne"
  // and "peppers" still counts as "pepper" (a trailing "s" is allowed).
  const text = ` ${String(name ?? "").toLowerCase().replace(/[^a-z]+/g, " ")} `;
  for (const [category, words] of CATEGORY_KEYWORDS) {
    if (words.some((word) => new RegExp(` ${word}(e?s)? `).test(text))) return category;
  }
  return "Other";
}
