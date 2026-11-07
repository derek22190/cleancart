package com.cleancart.overlay

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Persists Yuka-style Scan History and Favorites on-device using the exact `/api/scan` JSON schema
 * (`{ ok, product: { title, brand, category, imageUrl, ingredients }, result: { score, rating, color, flagged, yukaBreakdown }, swap }`).
 */
object ScanHistoryStore {
    private const val PREFS = "heybroc_yuka_store_v1"
    private const val KEY_HISTORY = "scan_history_json"
    private const val KEY_FAVORITES = "favorites_json"
    private const val MAX_HISTORY = 80

    fun extractTitle(item: JSONObject): String =
        item.optJSONObject("product")?.optString("title").orEmpty()
            .ifBlank { item.optString("productTitle") }
            .trim()

    private fun normKey(title: String): String =
        title.lowercase().replace(Regex("[^a-z0-9]+"), " ").trim()

    fun recordScan(context: Context, rawScanJson: JSONObject, storeKey: String = "walmart") {
        val title = extractTitle(rawScanJson)
        if (title.isBlank()) return
        val key = normKey(title)
        if (key.isBlank()) return

        val copy = JSONObject(rawScanJson.toString()).apply {
            put("scannedAtMs", System.currentTimeMillis())
            put("storeKey", storeKey)
        }

        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val existing = getHistory(context).filterNot { normKey(extractTitle(it)) == key }
        val updated = JSONArray().apply {
            put(copy)
            existing.take(MAX_HISTORY - 1).forEach { put(it) }
        }
        prefs.edit().putString(KEY_HISTORY, updated.toString()).apply()
    }

    fun getHistory(context: Context): List<JSONObject> {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_HISTORY, null) ?: return emptyList()
        return parseList(raw)
    }

    fun clearHistory(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().remove(KEY_HISTORY).apply()
    }

    fun getFavorites(context: Context): List<JSONObject> {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_FAVORITES, null) ?: return emptyList()
        return parseList(raw)
    }

    fun isFavorite(context: Context, title: String): Boolean {
        val key = normKey(title)
        if (key.isBlank()) return false
        return getFavorites(context).any { normKey(extractTitle(it)) == key }
    }

    /** Returns true if the item is now favorited, false if removed. */
    fun toggleFavorite(context: Context, itemJson: JSONObject): Boolean {
        val title = extractTitle(itemJson)
        val key = normKey(title)
        if (key.isBlank()) return false

        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val current = getFavorites(context)
        val already = current.any { normKey(extractTitle(it)) == key }
        val nextList = if (already) {
            current.filterNot { normKey(extractTitle(it)) == key }
        } else {
            listOf(JSONObject(itemJson.toString()).apply {
                put("favoritedAtMs", System.currentTimeMillis())
            }) + current
        }
        val arr = JSONArray().apply { nextList.forEach { put(it) } }
        prefs.edit().putString(KEY_FAVORITES, arr.toString()).apply()
        return !already
    }

    private fun parseList(raw: String): List<JSONObject> = runCatching {
        val arr = JSONArray(raw)
        val out = ArrayList<JSONObject>(arr.length())
        for (i in 0 until arr.length()) {
            arr.optJSONObject(i)?.let { out.add(it) }
        }
        out
    }.getOrDefault(emptyList())

    /**
     * Built-in starter products in the exact `/api/scan` format so History, Recs (side-by-side swaps),
     * Top Products (by category), and Search feel rich immediately upon install.
     */
    val EXPLORE_CATALOG: List<JSONObject> by lazy {
        listOf(
            sampleItem(
                title = "Hidden Valley Original Ranch Salad Dressing",
                brand = "Hidden Valley",
                category = "Salads & Dressings",
                score = 12,
                rating = "Bad",
                color = "red",
                imageUrl = "https://images.openfoodfacts.org/images/products/007/110/000/4151/front_en.52.400.jpg",
                ingredients = "Vegetable Oil (Soybean and/or Canola), Water, Sugar, Salt, Buttermilk, Egg Yolk, Natural Flavors, Phosphoric Acid, Xanthan Gum, Monosodium Glutamate, Artificial Flavors, Disodium Phosphate, Sorbic Acid, Calcium Disodium EDTA.",
                flagged = listOf(
                    FlagInfo("Calcium Disodium EDTA", 25, "high", "Synthetic chelating preservative linked to gut barrier irritation."),
                    FlagInfo("Soybean Oil", 15, "moderate", "Refined industrial omega-6 seed oil."),
                    FlagInfo("Canola Oil", 15, "moderate", "Refined industrial seed oil."),
                    FlagInfo("Monosodium Glutamate (MSG)", 15, "moderate", "Synthetic flavor enhancer."),
                    FlagInfo("Artificial Flavors", 15, "moderate", "Lab-synthesized flavor chemicals.")
                ),
                nutritionScore = 12,
                nutriGrade = "E",
                additiveScore = 0,
                organicScore = 0,
                swap = swapObj(
                    "Primal Kitchen Avocado Oil Ranch Dressing",
                    "Primal Kitchen",
                    90,
                    "https://images.openfoodfacts.org/images/products/085/523/200/7091/front_en.27.400.jpg",
                    "Avocado Oil, Water, Organic Vinegar, Organic Cage-Free Eggs, Organic Lemon Juice, Salt, Organic Dill, Organic Garlic, Organic Onion."
                )
            ),
            sampleItem(
                title = "Marketside Premium Romaine Salad Blend",
                brand = "Marketside",
                category = "Salads & Dressings",
                score = 100,
                rating = "Excellent",
                color = "green",
                imageUrl = "https://images.openfoodfacts.org/images/products/068/113/132/9477/front_en.3.400.jpg",
                ingredients = "Romaine Lettuce, Red Cabbage, Carrots.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "General Mills Cinnamon Toast Crunch Cereal",
                brand = "General Mills",
                category = "Cereals & Granolas",
                score = 24,
                rating = "Bad",
                color = "red",
                imageUrl = "https://images.openfoodfacts.org/images/products/001/600/012/4790/front_en.77.400.jpg",
                ingredients = "Whole Grain Wheat, Sugar, Rice Flour, Canola and/or Sunflower Oil, Fructose, Maltodextrin, Dextrose, Salt, Cinnamon, Trisodium Phosphate, Soy Lecithin, Caramel Color, BHT Added to Preserve Freshness.",
                flagged = listOf(
                    FlagInfo("BHT", 25, "high", "Synthetic petroleum-derived antioxidant preservative with endocrine disruption concerns."),
                    FlagInfo("Caramel Color", 15, "moderate", "Synthetic coloring agent."),
                    FlagInfo("Canola Oil", 15, "moderate", "Refined industrial seed oil."),
                    FlagInfo("Trisodium Phosphate", 15, "moderate", "Inorganic phosphate additive.")
                ),
                nutritionScore = 24,
                nutriGrade = "D",
                additiveScore = 0,
                organicScore = 0,
                swap = swapObj(
                    "Three Wishes Cinnamon Grain-Free Cereal",
                    "Three Wishes",
                    92,
                    "https://images.openfoodfacts.org/images/products/085/000/917/2029/front_en.3.400.jpg",
                    "Chickpea, Tapioca, Pea Protein, Organic Cane Sugar, Cinnamon, Monk Fruit, Salt."
                )
            ),
            sampleItem(
                title = "Marketside New England Clam Chowder, 16 oz",
                brand = "Marketside",
                category = "Soups & Chowders",
                score = 42,
                rating = "Poor",
                color = "yellow",
                imageUrl = "https://images.openfoodfacts.org/images/products/004/227/200/5628/front_en.28.400.jpg",
                ingredients = "Light Cream, Potatoes, Fish Stock, Sea Clams, Chopped Cockle, Onions, Wheat Flour, Soybean Oil, Butter, Clam Broth, Sea Salt, Celery, Salt Pork, Black Pepper, Worcestershire Sauce, Garlic, Natural Flavors.",
                flagged = listOf(
                    FlagInfo("Soybean Oil", 15, "moderate", "Refined omega-6 industrial seed oil extracted with hexane."),
                    FlagInfo("Natural Flavors", 5, "low", "Proprietary flavor blend that can include solvents and carriers.")
                ),
                nutritionScore = 45,
                nutriGrade = "B",
                additiveScore = 0,
                organicScore = 0,
                swap = swapObj(
                    "Amy's Organic Lentil Vegetable Soup",
                    "Amy's",
                    94,
                    "https://images.openfoodfacts.org/images/products/004/227/200/5628/front_en.28.400.jpg",
                    "Filtered Water, Organic Lentils, Organic Carrots, Organic Celery, Organic Potatoes, Organic Extra Virgin Olive Oil, Sea Salt."
                )
            ),
            sampleItem(
                title = "Campbell's New England Clam Chowder Soup",
                brand = "Campbell's",
                category = "Soups & Chowders",
                score = 27,
                rating = "Poor",
                color = "yellow",
                imageUrl = "https://images.openfoodfacts.org/images/products/005/100/001/2616/front_en.29.400.jpg",
                ingredients = "Clam Stock, Potatoes, Clams, Vegetable Oil (Corn, Canola, And/Or Soybean), Celery, Modified Food Starch, Wheat Flour, Salt, Cream, Soy Protein Concentrate, Monosodium Glutamate, Sodium Phosphate, Disodium Inosinate, Disodium Guanylate, Natural Flavoring, Soy Lecithin.",
                flagged = listOf(
                    FlagInfo("Canola Oil", 15, "moderate", "Refined industrial seed oil high in oxidized omega-6 fats."),
                    FlagInfo("Corn Oil", 15, "moderate", "Highly processed omega-6 seed oil."),
                    FlagInfo("Soybean Oil", 15, "moderate", "Refined omega-6 industrial seed oil."),
                    FlagInfo("Monosodium Glutamate (MSG)", 15, "moderate", "Excitatory flavor enhancer."),
                    FlagInfo("Sodium Phosphate", 15, "moderate", "Synthetic phosphate additive."),
                    FlagInfo("Soy Lecithin", 6, "low", "Solvent-extracted industrial emulsifier.")
                ),
                nutritionScore = 45,
                nutriGrade = "B",
                additiveScore = 0,
                organicScore = 0,
                swap = swapObj(
                    "Amy's Organic Lentil Vegetable Soup",
                    "Amy's",
                    94,
                    "https://images.openfoodfacts.org/images/products/004/227/200/5628/front_en.28.400.jpg",
                    "Filtered Water, Organic Lentils, Organic Carrots, Organic Celery, Organic Potatoes, Organic Extra Virgin Olive Oil, Sea Salt."
                )
            ),
            sampleItem(
                title = "Doritos Nacho Cheese Tortilla Chips",
                brand = "Doritos",
                category = "Chips & Snacks",
                score = 10,
                rating = "Bad",
                color = "red",
                imageUrl = "https://images.openfoodfacts.org/images/products/002/840/009/0896/front_en.102.400.jpg",
                ingredients = "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Maltodextrin, Salt, Cheddar Cheese, Whey, Monosodium Glutamate, Artificial Color (Yellow 6, Yellow 5, Red 40), Disodium Inosinate, Disodium Guanylate.",
                flagged = listOf(
                    FlagInfo("Red 40", 25, "high", "Petroleum-derived synthetic azo dye linked to hyperactivity in children."),
                    FlagInfo("Yellow 5", 25, "high", "Synthetic azo dye requiring warning labels in the EU."),
                    FlagInfo("Yellow 6", 25, "high", "Synthetic azo dye linked to hypersensitivity reactions."),
                    FlagInfo("Canola Oil", 15, "moderate", "Refined industrial seed oil."),
                    FlagInfo("Monosodium Glutamate (MSG)", 15, "moderate", "Synthetic flavor enhancer.")
                ),
                nutritionScore = 18,
                nutriGrade = "D",
                additiveScore = 0,
                organicScore = 0,
                swap = swapObj(
                    "Siete Sea Salt Tortilla Chips (Avocado Oil)",
                    "Siete",
                    88,
                    "https://images.openfoodfacts.org/images/products/085/176/900/7287/front_en.16.400.jpg",
                    "Cassava Flour, Avocado Oil, Coconut Flour, Chia Seed, Sea Salt."
                )
            ),
            sampleItem(
                title = "Santa Cruz Organic Dark Roasted Peanut Butter",
                brand = "Santa Cruz Organic",
                category = "Peanut Butter",
                score = 96,
                rating = "Excellent",
                color = "green",
                imageUrl = "https://images.openfoodfacts.org/images/products/003/619/212/2456/front_en.18.400.jpg",
                ingredients = "Organic Roasted Peanuts, Salt (1% or less).",
                flagged = emptyList(),
                nutritionScore = 56,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "Three Wishes Unsweetened Cocoa Grain-Free Cereal",
                brand = "Three Wishes",
                category = "Cereals & Granolas",
                score = 92,
                rating = "Excellent",
                color = "green",
                imageUrl = "https://images.openfoodfacts.org/images/products/085/000/917/2029/front_en.3.400.jpg",
                ingredients = "Chickpea, Tapioca, Pea Protein, Organic Cocoa, Monk Fruit, Salt.",
                flagged = emptyList(),
                nutritionScore = 52,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "Kerrygold Pure Irish Grass-Fed Salted Butter",
                brand = "Kerrygold",
                category = "Milk & Dairy",
                score = 88,
                rating = "Excellent",
                color = "green",
                imageUrl = "https://images.openfoodfacts.org/images/products/076/770/700/1079/front_en.112.400.jpg",
                ingredients = "Pasteurized Cream, Salt.",
                flagged = emptyList(),
                nutritionScore = 48,
                nutriGrade = "B",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "Lactaid 100% Lactose-Free Fat Free Milk",
                brand = "Lactaid",
                category = "Milk & Dairy",
                score = 90,
                rating = "Excellent",
                color = "green",
                imageUrl = "https://images.openfoodfacts.org/images/products/004/138/309/0363/front_en.31.400.jpg",
                ingredients = "Fat Free Milk, Lactase Enzyme, Vitamin A Palmitate, Vitamin D3.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            sampleItem(
                title = "Amy's Organic Low Fat Lentil Vegetable Soup",
                brand = "Amy's",
                category = "Soups & Chowders",
                score = 94,
                rating = "Excellent",
                color = "green",
                imageUrl = "https://images.openfoodfacts.org/images/products/004/227/200/5628/front_en.28.400.jpg",
                ingredients = "Filtered Water, Organic Onions, Organic Green Lentils, Organic Carrots, Organic Celery, Organic Potatoes, Organic Spinach, Organic Extra Virgin Olive Oil, Sea Salt, Organic Garlic, Organic Bay Leaves.",
                flagged = emptyList(),
                nutritionScore = 54,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "Siete Sea Salt Kettle Cooked Potato Chips (Avocado Oil)",
                brand = "Siete",
                category = "Chips & Snacks",
                score = 88,
                rating = "Excellent",
                color = "green",
                imageUrl = "https://images.openfoodfacts.org/images/products/085/176/900/7287/front_en.16.400.jpg",
                ingredients = "Potatoes, Avocado Oil, Sea Salt.",
                flagged = emptyList(),
                nutritionScore = 48,
                nutriGrade = "B",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "Dave's Killer Bread Organic 21 Whole Grains & Seeds",
                brand = "Dave's Killer Bread",
                category = "Bread & Bakery",
                score = 90,
                rating = "Excellent",
                color = "green",
                imageUrl = "https://images.openfoodfacts.org/images/products/001/376/402/7053/front_en.69.400.jpg",
                ingredients = "Organic Whole Wheat, Water, Organic Cane Sugar, Organic Cracked Whole Wheat, Organic 21 Whole Grains and Seeds Mix, Organic Vital Wheat Gluten, Organic Oat Fiber, Yeast, Sea Salt.",
                flagged = emptyList(),
                nutritionScore = 50,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "Hu Simple Organic 70% Dark Chocolate Bar",
                brand = "Hu Kitchen",
                category = "Dark Chocolate & Treats",
                score = 92,
                rating = "Excellent",
                color = "green",
                imageUrl = "https://images.openfoodfacts.org/images/products/085/018/000/6008/front_en.28.400.jpg",
                ingredients = "Organic Fair-Trade Cacao, Unrefined Organic Coconut Sugar, Organic Fair-Trade Cocoa Butter.",
                flagged = emptyList(),
                nutritionScore = 52,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            )
        )
    }

    private data class FlagInfo(val name: String, val penalty: Int, val risk: String, val explanation: String)

    private fun swapObj(
        title: String,
        brand: String,
        score: Int,
        imageUrl: String,
        ingredients: String
    ): JSONObject = JSONObject().apply {
        put("title", title)
        put("brand", brand)
        put("score", score)
        put("imageUrl", imageUrl)
        put("ingredients", ingredients)
        put("why", "No seed oils, synthetic dyes, or high-risk preservatives.")
        put("searchQuery", title)
    }

    private fun sampleItem(
        title: String,
        brand: String,
        category: String,
        score: Int,
        rating: String,
        color: String,
        imageUrl: String,
        ingredients: String,
        flagged: List<FlagInfo>,
        nutritionScore: Int,
        nutriGrade: String,
        additiveScore: Int,
        organicScore: Int,
        swap: JSONObject?
    ): JSONObject = JSONObject().apply {
        put("ok", true)
        put("category", category)
        put("product", JSONObject().apply {
            put("title", title)
            put("brand", brand)
            put("category", category)
            put("imageUrl", imageUrl)
            put("ingredients", ingredients)
        })
        put("result", JSONObject().apply {
            put("score", score)
            put("rating", rating)
            put("color", color)
            put("flagged", JSONArray().apply {
                flagged.forEach { f ->
                    put(JSONObject().apply {
                        put("name", f.name)
                        put("penalty", f.penalty)
                        put("risk", f.risk)
                        put("explanation", f.explanation)
                    })
                }
            })
            put("yukaBreakdown", JSONObject().apply {
                put("nutritionScore", nutritionScore)
                put("nutriScoreGrade", nutriGrade)
                put("additiveScore", additiveScore)
                put("organicScore", organicScore)
                put("highRiskCapped", flagged.any { it.risk == "high" })
            })
        })
        if (swap != null) {
            put("swap", swap)
        }
    }
}
