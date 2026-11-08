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

    fun canonicalKey(title: String): String {
        var s = title.lowercase()
            .replace(Regex("\\b\\d+(?:\\.\\d+)?\\s*(?:oz|fl\\s*oz|lb|lbs|g|kg|ml|l|ct|pk|pack)\\b"), " ")
            .replace(Regex("\\b(?:party\\s+size|family\\s+size|share\\s+size|snack\\s+size)\\b"), " ")
        if (s.contains("doritos") || s.contains("tostitos") || s.contains("siete")) {
            s = s.replace(Regex("\\b(?:flavored|tortilla\\s+chips|tortilla|chips)\\b"), " ")
        }
        return s.replace(Regex("[^a-z0-9]+"), " ").trim()
    }

    private fun normKey(title: String): String = canonicalKey(title)

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
        val seenKeys = HashSet<String>()
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            val prod = item.optJSONObject("product")
            val res = item.optJSONObject("result")
            val rawTitle = extractTitle(item)
            val key = canonicalKey(rawTitle)
            if (key.isBlank() || !seenKeys.add(key)) continue

            // Migrate any pre-fix cached Doritos entries that had 0/100 or 1/100 score or lowercase query titles
            if (key.contains("doritos")) {
                if (res != null && res.optInt("score", 18) <= 5) {
                    res.put("score", 18)
                    res.optJSONObject("yukaBreakdown")?.put("nutritionScore", 18)
                }
                if (prod != null) {
                    if (key == "doritos cool ranch" && (rawTitle == rawTitle.lowercase() || rawTitle.contains("Flavored", ignoreCase = true))) {
                        prod.put("title", "Doritos Cool Ranch Tortilla Chips")
                    } else if (key == "doritos nacho cheese" && rawTitle == rawTitle.lowercase()) {
                        prod.put("title", "Doritos Nacho Cheese Tortilla Chips")
                    }
                }
            }
            out.add(item)
        }
        out
    }.getOrDefault(emptyList())

    fun productImageUrl(title: String): String =
        "https://www.heybroc.com/api/product-image?q=${java.net.URLEncoder.encode(title.trim(), "UTF-8")}"

    /**
     * Instant 0ms on-device prefix/token matcher across user History, Favorites, and Explore catalog
     * for GPS-style live autocomplete while typing.
     */
    fun localSuggestions(context: Context, rawQuery: String, limit: Int = 6): List<JSONObject> {
        val q = rawQuery.trim().lowercase()
        if (q.isEmpty()) return emptyList()
        val tokens = q.split(Regex("\\s+")).filter { it.isNotBlank() }
        val pool = LinkedHashMap<String, JSONObject>()
        (EXPLORE_CATALOG + getHistory(context) + getFavorites(context)).forEach { item ->
            val t = extractTitle(item)
            val k = normKey(t)
            if (k.isNotBlank() && !pool.containsKey(k)) {
                pool[k] = item
            }
        }
        val scored = mutableListOf<Pair<Int, JSONObject>>()
        for ((_, item) in pool) {
            val prod = item.optJSONObject("product")
            val title = extractTitle(item)
            val brand = prod?.optString("brand").orEmpty()
            val cat = prod?.optString("category").orEmpty().ifBlank { item.optString("category") }
            val hay = "$brand $title $cat".lowercase()
            val titleLow = title.lowercase()
            val brandLow = brand.lowercase()
            val score = when {
                titleLow.startsWith(q) || brandLow.startsWith(q) -> 100
                hay.split(Regex("[^a-z0-9]+")).any { it.startsWith(q) } -> 85
                tokens.all { hay.contains(it) } -> 70
                else -> 0
            }
            if (score > 0) scored.add(score to item)
        }
        return scored.sortedByDescending { it.first }.take(limit).map { it.second }
    }

    /**
     * Built-in starter products in the exact `/api/scan` format so My Scans, Clean Swaps,
     * Top Picks (by category), and Search feel rich immediately upon install.
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
                imageUrl = productImageUrl("Hidden Valley Original Ranch Salad Dressing"),
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
                    productImageUrl("Primal Kitchen Avocado Oil Ranch Dressing"),
                    "Avocado Oil, Water, Organic Vinegar, Organic Cage-Free Eggs, Organic Lemon Juice, Salt, Organic Dill, Organic Garlic, Organic Onion."
                )
            ),
            sampleItem(
                title = "Marketside Organic Baby Spinach & Romaine Salad Blend",
                brand = "Marketside Organic",
                category = "Salads & Dressings",
                score = 100,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Marketside Organic Baby Spinach Romaine Salad"),
                ingredients = "Organic Romaine Lettuce, Organic Baby Spinach, Organic Red Cabbage, Organic Carrots.",
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
                imageUrl = productImageUrl("General Mills Cinnamon Toast Crunch Cereal"),
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
                    "Nature's Path Organic Heritage Flakes Cereal",
                    "Nature's Path",
                    92,
                    productImageUrl("Nature's Path Organic Heritage Flakes Cereal"),
                    "Organic Whole Wheat Meal, Organic Oat Flour, Organic Khorasan Wheat, Organic Barley Flour, Organic Spelt Flour, Organic Millet, Organic Quinoa, Organic Cane Sugar, Sea Salt."
                )
            ),
            sampleItem(
                title = "Marketside New England Clam Chowder, 16 oz",
                brand = "Marketside",
                category = "Soups & Chowders",
                score = 42,
                rating = "Poor",
                color = "yellow",
                imageUrl = productImageUrl("Marketside New England Clam Chowder 16 oz"),
                ingredients = "Light Cream, Potatoes, Fish Stock, Sea Clams, Chopped Cockle, Onions, Wheat Flour, Soybean Oil, Butter, Clam Broth, Sea Salt, Celery, Salt Pork, Black Pepper, Worcestershire Sauce, Garlic, Natural Flavors.",
                flagged = listOf(
                    FlagInfo("Soybean Oil", 15, "moderate", "Refined omega-6 industrial seed oil extracted with hexane."),
                    FlagInfo("Natural Flavors", 5, "low", "Proprietary flavor blend that can include solvents and carriers.")
                ),
                nutritionScore = 42,
                nutriGrade = "B",
                additiveScore = 0,
                organicScore = 0,
                swap = swapObj(
                    "Amy's Organic Low Fat Lentil Vegetable Soup",
                    "Amy's Organic",
                    94,
                    productImageUrl("Amy's Organic Lentil Vegetable Soup"),
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
                imageUrl = productImageUrl("Campbell's Chunky New England Clam Chowder Soup"),
                ingredients = "Clam Stock, Potatoes, Clams, Vegetable Oil (Corn, Canola, And/Or Soybean), Celery, Modified Food Starch, Wheat Flour, Salt, Cream, Soy Protein Concentrate, Monosodium Glutamate, Sodium Phosphate, Disodium Inosinate, Disodium Guanylate, Natural Flavoring, Soy Lecithin.",
                flagged = listOf(
                    FlagInfo("Canola Oil", 15, "moderate", "Refined industrial seed oil high in oxidized omega-6 fats."),
                    FlagInfo("Corn Oil", 15, "moderate", "Highly processed omega-6 seed oil."),
                    FlagInfo("Soybean Oil", 15, "moderate", "Refined omega-6 industrial seed oil."),
                    FlagInfo("Monosodium Glutamate (MSG)", 15, "moderate", "Excitatory flavor enhancer."),
                    FlagInfo("Sodium Phosphate", 15, "moderate", "Synthetic phosphate additive."),
                    FlagInfo("Soy Lecithin", 6, "low", "Solvent-extracted industrial emulsifier.")
                ),
                nutritionScore = 27,
                nutriGrade = "C",
                additiveScore = 0,
                organicScore = 0,
                swap = swapObj(
                    "Amy's Organic Low Fat Lentil Vegetable Soup",
                    "Amy's Organic",
                    94,
                    productImageUrl("Amy's Organic Lentil Vegetable Soup"),
                    "Filtered Water, Organic Lentils, Organic Carrots, Organic Celery, Organic Potatoes, Organic Extra Virgin Olive Oil, Sea Salt."
                )
            ),
            sampleItem(
                title = "Doritos Nacho Cheese Tortilla Chips",
                brand = "Doritos",
                category = "Chips & Snacks",
                score = 18,
                rating = "Bad",
                color = "red",
                imageUrl = productImageUrl("Doritos Nacho Cheese Tortilla Chips"),
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
                    "Siete Grain Free Sea Salt Tortilla Chips (Avocado Oil)",
                    "Siete",
                    72,
                    productImageUrl("Siete Grain Free Sea Salt Tortilla Chips"),
                    "Cassava Flour, Avocado Oil, Coconut Flour, Chia Seed, Sea Salt."
                )
            ),
            sampleItem(
                title = "Doritos Cool Ranch Tortilla Chips",
                brand = "Doritos",
                category = "Chips & Snacks",
                score = 18,
                rating = "Bad",
                color = "red",
                imageUrl = productImageUrl("Doritos Cool Ranch Tortilla Chips"),
                ingredients = "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Maltodextrin, Salt, Tomato Powder, Lactose, Whey, Monosodium Glutamate, Artificial Color (Red 40, Blue 1, Yellow 5), Disodium Inosinate, Disodium Guanylate.",
                flagged = listOf(
                    FlagInfo("Red 40", 25, "high", "Petroleum-derived synthetic azo dye."),
                    FlagInfo("Blue 1", 25, "high", "Synthetic triphenylmethane dye."),
                    FlagInfo("Yellow 5", 25, "high", "Synthetic azo dye."),
                    FlagInfo("Canola Oil", 15, "moderate", "Refined industrial seed oil."),
                    FlagInfo("Monosodium Glutamate (MSG)", 15, "moderate", "Synthetic flavor enhancer.")
                ),
                nutritionScore = 18,
                nutriGrade = "D",
                additiveScore = 0,
                organicScore = 0,
                swap = swapObj(
                    "Siete Grain Free Sea Salt Tortilla Chips (Avocado Oil)",
                    "Siete",
                    72,
                    productImageUrl("Siete Grain Free Sea Salt Tortilla Chips"),
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
                imageUrl = productImageUrl("Santa Cruz Organic Dark Roasted Peanut Butter"),
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
                imageUrl = productImageUrl("Three Wishes Cocoa Grain Free Cereal"),
                ingredients = "Chickpea, Tapioca, Pea Protein, Organic Cocoa, Monk Fruit, Salt.",
                flagged = emptyList(),
                nutritionScore = 52,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "Organic Valley Pasture-Raised Salted Butter",
                brand = "Organic Valley",
                category = "Milk & Dairy",
                score = 80,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Organic Valley Pasture Raised Salted Butter"),
                ingredients = "Organic Pasteurized Sweet Cream, Salt.",
                flagged = emptyList(),
                nutritionScore = 40,
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
                imageUrl = productImageUrl("Lactaid Fat Free Milk"),
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
                imageUrl = productImageUrl("Amy's Organic Lentil Vegetable Soup"),
                ingredients = "Filtered Water, Organic Onions, Organic Green Lentils, Organic Carrots, Organic Celery, Organic Potatoes, Organic Spinach, Organic Extra Virgin Olive Oil, Sea Salt, Organic Garlic, Organic Bay Leaves.",
                flagged = emptyList(),
                nutritionScore = 54,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "Boulder Canyon Avocado Oil Canyon Poppers / Kettle Chips",
                brand = "Boulder Canyon",
                category = "Chips & Snacks",
                score = 82,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Boulder Canyon Avocado Oil Kettle Chips"),
                ingredients = "Potatoes, Avocado Oil, Sea Salt.",
                flagged = emptyList(),
                nutritionScore = 52,
                nutriGrade = "B",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            sampleItem(
                title = "Dave's Killer Bread Organic 21 Whole Grains & Seeds",
                brand = "Dave's Killer Bread",
                category = "Bread & Bakery",
                score = 90,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Dave's Killer Bread Organic 21 Whole Grains"),
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
                imageUrl = productImageUrl("Hu Simple Organic 70% Dark Chocolate Bar"),
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
