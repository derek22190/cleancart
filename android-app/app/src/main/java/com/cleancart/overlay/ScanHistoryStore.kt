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
            val rawTitle = extractTitle(item)
            val key = canonicalKey(rawTitle)
            if (key.isBlank() || !seenKeys.add(key)) continue
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
        val tokens = q.split(Regex("[^a-z0-9]+")).filter { it.isNotBlank() }
        if (tokens.isEmpty()) return emptyList()
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
            val kw = prod?.optString("keywords").orEmpty()
            val hayWords = "$brand $title $cat $kw".lowercase().split(Regex("[^a-z0-9]+")).filter { it.isNotBlank() }
            val titleLow = title.lowercase()
            val brandLow = brand.lowercase()

            val allTokensMatch = tokens.all { tok ->
                hayWords.any { w -> w.startsWith(tok) || (tok.length >= 4 && w.contains(tok)) }
            }
            val score = when {
                titleLow.startsWith(q) || brandLow.startsWith(q) -> 100
                allTokensMatch && hayWords.any { it == tokens[0] } -> 90
                allTokensMatch -> 78
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
            ),
            // ==================== ENERGY DRINKS & PRE-WORKOUTS ====================
            sampleItem(
                title = "Monster Energy Original Green Energy Drink, 16 fl oz",
                brand = "Monster Energy",
                category = "Energy Drinks & Pre-Workouts",
                score = 6,
                rating = "Bad",
                color = "red",
                imageUrl = productImageUrl("Monster Energy Original Green 16 oz"),
                description = "Carbonated energy drink with 160mg caffeine, 54g added sugar, sucralose, and synthetic preservatives (sorbic & benzoic acid).",
                keywords = "monster energy drink original green monster green 16 oz caffeine taurine",
                ingredients = "Carbonated Water, Sucrose, Glucose, Citric Acid, Natural Flavors, Taurine, Sodium Citrate, Color Added, Panax Ginseng Root Extract, L-Carnitine L-Tartrate, Caffeine, Sorbic Acid (Preservative), Benzoic Acid (Preservative), Niacinamide, Sucralose, Inositol, Pyridoxine Hydrochloride, Riboflavin, Maltodextrin, Cyanocobalamin.",
                flagged = listOf(
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener linked to gut microbiome shifts."),
                    FlagInfo("Potassium Sorbate / Sorbic Acid", 6, "low", "Synthetic mold and yeast preservative."),
                    FlagInfo("Sodium Benzoate / Benzoic Acid", 15, "moderate", "Synthetic preservative that can form benzene with ascorbic/citric acid.")
                ),
                nutritionScore = 0,
                nutriGrade = "E",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "Guayakí Organic Yerba Mate Unsweetened Clean Energy Tea",
                    "Guayakí",
                    90,
                    productImageUrl("Guayaki Organic Yerba Mate Tea"),
                    "Purified Water, Organic Brewed Yerba Mate, Organic Lemon Juice."
                )
            ),
            sampleItem(
                title = "Monster Energy Zero Ultra White Energy Drink, 16 fl oz",
                brand = "Monster Energy",
                category = "Energy Drinks & Pre-Workouts",
                score = 42,
                rating = "Poor",
                color = "orange",
                imageUrl = productImageUrl("Monster Energy Zero Ultra White 16 oz"),
                description = "Zero-sugar carbonated energy drink (150mg caffeine) sweetened with erythritol, sucralose, and acesulfame potassium.",
                keywords = "monster zero ultra white monster sugar free energy drink monster white",
                ingredients = "Carbonated Water, Citric Acid, Erythritol, Taurine, Sodium Citrate, Panax Ginseng Flavor, L-Carnitine L-Tartrate, Caffeine, Sorbic Acid (Preservative), Sucralose, Benzoic Acid (Preservative), Niacinamide, Acesulfame Potassium, Natural Flavors, Inositol, Pyridoxine Hydrochloride, Cyanocobalamin.",
                flagged = listOf(
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener."),
                    FlagInfo("Acesulfame Potassium (Ace-K)", 15, "moderate", "Synthetic high-intensity sweetener."),
                    FlagInfo("Sodium Benzoate / Benzoic Acid", 15, "moderate", "Synthetic preservative."),
                    FlagInfo("Potassium Sorbate / Sorbic Acid", 6, "low", "Synthetic preservative.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "Guayakí Organic Yerba Mate Unsweetened Clean Energy Tea",
                    "Guayakí",
                    90,
                    productImageUrl("Guayaki Organic Yerba Mate Tea"),
                    "Purified Water, Organic Brewed Yerba Mate, Organic Lemon Juice."
                )
            ),
            sampleItem(
                title = "Red Bull Energy Drink Original, 8.4 fl oz",
                brand = "Red Bull",
                category = "Energy Drinks & Pre-Workouts",
                score = 30,
                rating = "Poor",
                color = "orange",
                imageUrl = productImageUrl("Red Bull Energy Drink Original 8.4 oz"),
                description = "Classic Austrian energy drink with 80mg caffeine, 1000mg taurine, B-group vitamins, and 27g added sugars per 8.4 fl oz can.",
                keywords = "red bull redbull energy drink original 8.4 oz 12 oz taurine caffeine",
                ingredients = "Carbonated Water, Sucrose, Glucose, Citric Acid, Taurine, Sodium Bicarbonate, Magnesium Carbonate, Caffeine, Niacinamide, Calcium Pantothenate, Pyridoxine HCl, Vitamin B12, Natural and Artificial Flavors, Colors.",
                flagged = emptyList(),
                nutritionScore = 0,
                nutriGrade = "E",
                additiveScore = 30,
                organicScore = 0,
                swap = swapObj(
                    "Guayakí Organic Yerba Mate Unsweetened Clean Energy Tea",
                    "Guayakí",
                    90,
                    productImageUrl("Guayaki Organic Yerba Mate Tea"),
                    "Purified Water, Organic Brewed Yerba Mate, Organic Lemon Juice."
                )
            ),
            sampleItem(
                title = "Red Bull Sugarfree Energy Drink, 8.4 fl oz",
                brand = "Red Bull",
                category = "Energy Drinks & Pre-Workouts",
                score = 42,
                rating = "Poor",
                color = "orange",
                imageUrl = productImageUrl("Red Bull Sugarfree Energy Drink 8.4 oz"),
                description = "Zero-sugar Red Bull with 80mg caffeine and taurine, sweetened with aspartame and acesulfame potassium (Ace-K).",
                keywords = "red bull sugarfree sugar free redbull diet zero sugar energy drink",
                ingredients = "Carbonated Water, Citric Acid, Taurine, Sodium Bicarbonate, Magnesium Carbonate, Caffeine, Acesulfame K, Aspartame, Niacinamide, Calcium Pantothenate, Pyridoxine HCl, Vitamin B12, Xanthan Gum, Natural and Artificial Flavors, Colors.",
                flagged = listOf(
                    FlagInfo("Aspartame", 15, "moderate", "Artificial sweetener classified by IARC as Group 2B."),
                    FlagInfo("Acesulfame Potassium (Ace-K)", 15, "moderate", "Synthetic high-intensity sweetener.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "Guayakí Organic Yerba Mate Unsweetened Clean Energy Tea",
                    "Guayakí",
                    90,
                    productImageUrl("Guayaki Organic Yerba Mate Tea"),
                    "Purified Water, Organic Brewed Yerba Mate, Organic Lemon Juice."
                )
            ),
            sampleItem(
                title = "Celsius Live Fit Sparkling Orange Fitness Energy Drink, 12 fl oz",
                brand = "Celsius",
                category = "Energy Drinks & Pre-Workouts",
                score = 51,
                rating = "Good",
                color = "yellow",
                imageUrl = productImageUrl("Celsius Live Fit Sparkling Orange Energy Drink"),
                description = "Zero-sugar thermogenic fitness energy drink with 200mg caffeine from green tea & guarana, sweetened with sucralose.",
                keywords = "celsius energy drink live fit sparkling orange peach vibe arctic vibe fitness",
                ingredients = "Filtered Carbonated Water, Citric Acid, Taurine, Guarana Seed Extract, Green Tea Extract, Caffeine, Ascorbic Acid, Glucuronolactone, Ginger Root Extract, Calcium Carbonate, Sucralose, Beta-Carotene (for Color), Natural Flavor, Niacinamide, Pyridoxine Hydrochloride, Biotin, Cyanocobalamin.",
                flagged = listOf(
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 15,
                organicScore = 0,
                swap = swapObj(
                    "Guayakí Organic Yerba Mate Unsweetened Clean Energy Tea",
                    "Guayakí",
                    90,
                    productImageUrl("Guayaki Organic Yerba Mate Tea"),
                    "Purified Water, Organic Brewed Yerba Mate, Organic Lemon Juice."
                )
            ),
            sampleItem(
                title = "C4 Performance Energy Drink Frozen Bombsicle, 16 fl oz",
                brand = "C4 Energy",
                category = "Energy Drinks & Pre-Workouts",
                score = 42,
                rating = "Poor",
                color = "orange",
                imageUrl = productImageUrl("C4 Performance Energy Frozen Bombsicle 16 oz"),
                description = "Pre-workout carbonated energy drink with 200mg caffeine, CarnoSyn beta-alanine, and citrulline, sweetened with sucralose & Ace-K.",
                keywords = "c4 energy drink pre workout preworkout frozen bombsicle skittles starburst cellucor",
                ingredients = "Carbonated Water, CarnoSyn Beta-Alanine, L-Citrulline, Malic Acid, Betaine Anhydrous, Citric Acid, Natural Flavors, Caffeine Anhydrous, Sucralose, Potassium Sorbate (Preservative), Acesulfame Potassium, Niacinamide, Cyanocobalamin.",
                flagged = listOf(
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener."),
                    FlagInfo("Acesulfame Potassium (Ace-K)", 15, "moderate", "Synthetic high-intensity sweetener."),
                    FlagInfo("Potassium Sorbate", 6, "low", "Synthetic preservative.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "Ora Organic Renewable Energy Clean Pre-Workout",
                    "Ora Organic",
                    90,
                    productImageUrl("Ora Organic Renewable Energy Pre Workout"),
                    "Organic Green Coffee Bean, Organic Yerba Mate, Organic Matcha, Organic Beet Root, Organic Maca Root, Organic Stevia."
                )
            ),
            sampleItem(
                title = "C4 Original Pre-Workout Powder Icy Blue Razz",
                brand = "Cellucor C4",
                category = "Energy Drinks & Pre-Workouts",
                score = 42,
                rating = "Poor",
                color = "orange",
                imageUrl = productImageUrl("C4 Original Pre Workout Powder Icy Blue Razz"),
                description = "Explosive pre-workout supplement powder with 150mg caffeine, 1.6g beta-alanine, and 1g creatine nitrate; contains Blue 1, sucralose, and Ace-K.",
                keywords = "c4 pre workout preworkout powder cellucor icy blue razz fruit punch",
                ingredients = "CarnoSyn Beta-Alanine, Creatine Nitrate, Arginine Alpha-Ketoglutarate, Citric Acid, Polydextrose, Malic Acid, Natural and Artificial Flavors, Calcium Silicate, Silicon Dioxide, Sucralose, Acesulfame Potassium, Caffeine Anhydrous, FD&C Blue #1.",
                flagged = listOf(
                    FlagInfo("Blue 1", 25, "high", "Synthetic triphenylmethane dye."),
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener."),
                    FlagInfo("Acesulfame Potassium (Ace-K)", 15, "moderate", "Synthetic high-intensity sweetener.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "Ora Organic Renewable Energy Clean Pre-Workout",
                    "Ora Organic",
                    90,
                    productImageUrl("Ora Organic Renewable Energy Pre Workout"),
                    "Organic Green Coffee Bean, Organic Yerba Mate, Organic Matcha, Organic Beet Root, Organic Maca Root, Organic Stevia."
                )
            ),
            sampleItem(
                title = "Alani Nu Energy Drink Cosmic Stardust, 12 fl oz",
                brand = "Alani Nu",
                category = "Energy Drinks & Pre-Workouts",
                score = 42,
                rating = "Poor",
                color = "orange",
                imageUrl = productImageUrl("Alani Nu Energy Drink Cosmic Stardust 12 oz"),
                description = "Zero-sugar energy drink with 200mg caffeine, L-theanine, and biotin, sweetened with erythritol, sucralose, and Ace-K.",
                keywords = "alani nu energy drink cosmic stardust cherry slush breezeberry",
                ingredients = "Carbonated Water, Citric Acid, Taurine, Natural Flavor, Erythritol, Sodium Citrate, L-Theanine, Caffeine, Sucralose, Panax Ginseng Root Extract, Sodium Benzoate (Preservative), Potassium Sorbate (Preservative), Acesulfame Potassium, L-Carnitine Tartrate, D-Biotin.",
                flagged = listOf(
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener."),
                    FlagInfo("Acesulfame Potassium (Ace-K)", 15, "moderate", "Synthetic high-intensity sweetener."),
                    FlagInfo("Sodium Benzoate", 15, "moderate", "Synthetic preservative.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "Guayakí Organic Yerba Mate Unsweetened Clean Energy Tea",
                    "Guayakí",
                    90,
                    productImageUrl("Guayaki Organic Yerba Mate Tea"),
                    "Purified Water, Organic Brewed Yerba Mate, Organic Lemon Juice."
                )
            ),
            sampleItem(
                title = "Ghost Energy Drink Sour Patch Kids Redberry, 16 fl oz",
                brand = "Ghost",
                category = "Energy Drinks & Pre-Workouts",
                score = 42,
                rating = "Poor",
                color = "orange",
                imageUrl = productImageUrl("Ghost Energy Drink Sour Patch Kids Redberry 16 oz"),
                description = "Nootropic zero-sugar energy drink with 200mg natural caffeine, Alpha-GPC, and L-carnitine; sweetened with sucralose & Ace-K.",
                keywords = "ghost energy drink sour patch kids swedish fish warheads nootropic",
                ingredients = "Carbonated Water, Citric Acid, Acetyl-L-Carnitine HCl, Taurine, Natural and Artificial Flavor, Tartaric Acid, Alpha-GPC, Natural Caffeine (from Coffee Bean), Sucralose, Acesulfame Potassium, Sodium Benzoate (Preservative), Potassium Sorbate (Preservative).",
                flagged = listOf(
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener."),
                    FlagInfo("Acesulfame Potassium (Ace-K)", 15, "moderate", "Synthetic high-intensity sweetener."),
                    FlagInfo("Sodium Benzoate", 15, "moderate", "Synthetic preservative.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "Guayakí Organic Yerba Mate Unsweetened Clean Energy Tea",
                    "Guayakí",
                    90,
                    productImageUrl("Guayaki Organic Yerba Mate Tea"),
                    "Purified Water, Organic Brewed Yerba Mate, Organic Lemon Juice."
                )
            ),
            sampleItem(
                title = "Guayakí Organic Yerba Mate Unsweetened Clean Energy Tea, 15.5 fl oz",
                brand = "Guayakí",
                category = "Energy Drinks & Pre-Workouts",
                score = 100,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Guayaki Organic Yerba Mate Clean Energy Tea"),
                description = "USDA Organic brewed yerba mate delivering 150mg clean plant caffeine with zero artificial sweeteners, dyes, or synthetic preservatives.",
                keywords = "guayaki yerba mate organic energy tea clean energy drink",
                ingredients = "Purified Water, Organic Brewed Yerba Mate (Water, Organic Yerba Mate), Organic Lemon Juice.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "Ora Organic Renewable Energy Clean Pre-Workout Powder, Beet & Pomegranate",
                brand = "Ora Organic",
                category = "Energy Drinks & Pre-Workouts",
                score = 100,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Ora Organic Renewable Energy Pre Workout Powder"),
                description = "USDA Organic plant-based pre-workout with 90mg caffeine from organic green coffee bean, matcha & yerba mate, nitric oxide beet root, and adaptogens.",
                keywords = "ora organic pre workout preworkout clean preworkout beet root",
                ingredients = "Organic Pomegranate Juice Powder, Organic Beet Root Powder, Organic Coconut Water, Organic Green Coffee Bean Extract, Organic Yerba Mate Extract, Organic Matcha Green Tea, Organic Eleuthero Root, Organic Ginseng Root, Organic Stevia Leaf Extract.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "Core Power Fairlife 26g Protein Milk Shake, Chocolate, 14 fl oz",
                brand = "Core Power by Fairlife",
                category = "Energy Drinks & Pre-Workouts",
                score = 42,
                rating = "Poor",
                color = "orange",
                imageUrl = productImageUrl("Core Power Fairlife 26g Protein Milk Shake Chocolate"),
                description = "Ready-to-drink post-workout protein recovery shake made from ultra-filtered milk (26g protein); contains carrageenan, sucralose, and Ace-K.",
                keywords = "core power fairlife protein shake chocolate 26g 42g elite muscle milk",
                ingredients = "Filtered Lowfat Grade A Milk, Alkalized Cocoa, Natural Flavors, Lactase Enzyme, Acesulfame Potassium, Carrageenan, Cellulose Gel, Cellulose Gum, Monk Fruit Juice Concentrate, Salt, Stevia Leaf Extract, Sucralose, Vitamin A Palmitate, Vitamin D3.",
                flagged = listOf(
                    FlagInfo("Carrageenan", 25, "high", "Seaweed thickener linked to intestinal inflammation."),
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener."),
                    FlagInfo("Acesulfame Potassium (Ace-K)", 15, "moderate", "Synthetic high-intensity sweetener.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "Orgain Organic Grass-Fed Clean Protein Shake",
                    "Orgain",
                    88,
                    productImageUrl("Orgain Organic Grass Fed Protein Shake"),
                    "Filtered Water, Orgain Organic Milk Protein Concentrate (Grass-Fed), Organic Erythritol, Organic Alkalized Cocoa, Organic Acacia, Organic Stevia."
                )
            ),
            // ==================== SODAS & PREBIOTIC DRINKS ====================
            sampleItem(
                title = "Coca-Cola Original Classic Soda, 12 fl oz Can",
                brand = "Coca-Cola",
                category = "Sodas & Prebiotic Drinks",
                score = 6,
                rating = "Bad",
                color = "red",
                imageUrl = productImageUrl("Coca Cola Classic Soda 12 oz Can"),
                description = "Classic cola soft drink sweetened with 39g high fructose corn syrup and colored with Class IV Caramel Color.",
                keywords = "coca cola coke classic soda pop soft drink 12 oz",
                ingredients = "Carbonated Water, High Fructose Corn Syrup, Caramel Color, Phosphoric Acid, Natural Flavors, Caffeine.",
                flagged = listOf(
                    FlagInfo("High-Fructose Corn Syrup", 15, "moderate", "Industrial liquid sweetener linked to visceral fat and insulin resistance."),
                    FlagInfo("Caramel Color (Class III/IV)", 15, "moderate", "Ammonia-sulfite caramel coloring that may carry 4-MEI.")
                ),
                nutritionScore = 0,
                nutriGrade = "E",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "OLIPOP Vintage Cola Prebiotic Soda",
                    "OLIPOP",
                    90,
                    productImageUrl("OLIPOP Vintage Cola Prebiotic Soda"),
                    "Carbonated Water, OLISMART Prebiotic Botanical Blend (Cassava Root Fiber, Chicory Root Inulin, Jerusalem Artichoke Inulin, Nopal Cactus, Marshmallow Root), Apple Juice Concentrate, Cinnamon, Stevia Leaf."
                )
            ),
            sampleItem(
                title = "Diet Coke Zero Calorie Cola Soda, 12 fl oz Can",
                brand = "Coca-Cola",
                category = "Sodas & Prebiotic Drinks",
                score = 42,
                rating = "Poor",
                color = "orange",
                imageUrl = productImageUrl("Diet Coke Soda 12 oz Can"),
                description = "Zero-calorie diet cola sweetened with aspartame, colored with Caramel Color, and preserved with potassium benzoate.",
                keywords = "diet coke coca cola zero sugar diet soda aspartame",
                ingredients = "Carbonated Water, Caramel Color, Aspartame, Phosphoric Acid, Potassium Benzoate (to Protect Taste), Natural Flavors, Citric Acid, Caffeine.",
                flagged = listOf(
                    FlagInfo("Aspartame", 15, "moderate", "Artificial sweetener classified by IARC as Group 2B."),
                    FlagInfo("Caramel Color (Class III/IV)", 15, "moderate", "Ammonia-sulfite caramel coloring."),
                    FlagInfo("Sodium/Potassium Benzoate", 15, "moderate", "Synthetic preservative.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "OLIPOP Vintage Cola Prebiotic Soda",
                    "OLIPOP",
                    90,
                    productImageUrl("OLIPOP Vintage Cola Prebiotic Soda"),
                    "Carbonated Water, OLISMART Prebiotic Botanical Blend, Apple Juice Concentrate, Cinnamon, Stevia Leaf."
                )
            ),
            sampleItem(
                title = "Mountain Dew Original Citrus Soda, 12 fl oz Can",
                brand = "Mountain Dew",
                category = "Sodas & Prebiotic Drinks",
                score = 6,
                rating = "Bad",
                color = "red",
                imageUrl = productImageUrl("Mountain Dew Citrus Soda 12 oz Can"),
                description = "Caffeinated citrus soft drink with 46g high fructose corn syrup, Yellow 5 synthetic dye, sodium benzoate, and calcium disodium EDTA.",
                keywords = "mountain dew mtn dew citrus soda baja blast code red",
                ingredients = "Carbonated Water, High Fructose Corn Syrup, Concentrated Orange Juice, Citric Acid, Natural Flavor, Sodium Benzoate (Preserves Freshness), Caffeine, Sodium Citrate, Gum Arabic, Erythorbic Acid, Calcium Disodium EDTA, Yellow 5.",
                flagged = listOf(
                    FlagInfo("Yellow 5", 25, "high", "Synthetic azo dye requiring hyperactivity warning labels in the EU."),
                    FlagInfo("High-Fructose Corn Syrup", 15, "moderate", "Industrial liquid sweetener."),
                    FlagInfo("Sodium Benzoate", 15, "moderate", "Synthetic preservative.")
                ),
                nutritionScore = 0,
                nutriGrade = "E",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "Spindrift Organic Sparkling Water with Real Squeezed Fruit",
                    "Spindrift",
                    94,
                    productImageUrl("Spindrift Sparkling Water Lemon Lime"),
                    "Carbonated Water, Real Squeezed Lemon and Lime Juice."
                )
            ),
            sampleItem(
                title = "OLIPOP Vintage Cola Prebiotic Soda, 12 fl oz Can",
                brand = "OLIPOP",
                category = "Sodas & Prebiotic Drinks",
                score = 90,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("OLIPOP Vintage Cola Prebiotic Soda 12 oz"),
                description = "Gut-healthy prebiotic soda with 9g plant fiber from cassava root, chicory inulin & botanicals, and only 2g sugar with no artificial sweeteners.",
                keywords = "olipop vintage cola prebiotic soda root beer cream soda",
                ingredients = "Carbonated Water, OLISMART (Cassava Root Fiber, Chicory Root Inulin, Jerusalem Artichoke Inulin, Nopal Cactus, Marshmallow Root, Calendula Flower, Kudzu Root), Cassava Root Syrup, Apple Juice Concentrate, Lime Juice, Vinegar, Caramel, Himalayan Pink Salt, Green Tea Caffeine, Stevia Leaf, Cinnamon, Vanilla Bean.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            sampleItem(
                title = "Poppi Strawberry Lemon Prebiotic Soda, 12 fl oz Can",
                brand = "Poppi",
                category = "Sodas & Prebiotic Drinks",
                score = 90,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Poppi Strawberry Lemon Prebiotic Soda 12 oz"),
                description = "Sparkling prebiotic soda made with unfiltered apple cider vinegar, organic agave inulin fiber, real fruit juice, and stevia.",
                keywords = "poppi prebiotic soda strawberry lemon orange raspberry rose",
                ingredients = "Sparkling Water, Organic Cane Sugar, Apple Cider Vinegar, Organic Agave Inulin, Strawberry Juice, Lemon Juice, Natural Flavors, Fruit and Vegetable Juice (for Color), Stevia.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            // ==================== WATERS, SELTZERS & HYDRATION ====================
            sampleItem(
                title = "FIJI Natural Artesian Water, 16.9 fl oz Bottle",
                brand = "FIJI Water",
                category = "Waters, Seltzers & Hydration",
                score = 90,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("FIJI Natural Artesian Water Bottle"),
                description = "Natural artesian aquifer water bottled at the source in Viti Levu, Fiji, with naturally occurring silica and electrolytes.",
                keywords = "fiji water natural artesian bottled water spring water",
                ingredients = "Natural Artesian Water.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            sampleItem(
                title = "Spindrift Sparkling Water with Real Squeezed Raspberry Lime, 12 fl oz",
                brand = "Spindrift",
                category = "Waters, Seltzers & Hydration",
                score = 90,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Spindrift Sparkling Water Raspberry Lime"),
                description = "Sparkling water made with only carbonated water and real squeezed fruit puree/juice — zero synthetic 'natural flavors' or sweeteners.",
                keywords = "spindrift sparkling water seltzer raspberry lime lemon pink lemonade",
                ingredients = "Carbonated Water, Raspberry Puree, Lime Juice.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            sampleItem(
                title = "Gatorade Thirst Quencher Fruit Punch Sports Drink, 20 fl oz",
                brand = "Gatorade",
                category = "Waters, Seltzers & Hydration",
                score = 6,
                rating = "Bad",
                color = "red",
                imageUrl = productImageUrl("Gatorade Thirst Quencher Fruit Punch 20 oz"),
                description = "Conventional sports electrolyte drink containing 34g added sugar (dextrose & sucrose) and Red 40 petroleum-based food dye.",
                keywords = "gatorade fruit punch cool blue glacier freeze sports drink electrolytes",
                ingredients = "Water, Sugar, Dextrose, Citric Acid, Salt, Sodium Citrate, Monopotassium Phosphate, Gum Arabic, Natural Flavor, Sucrose Acetate Isobutyrate, Glycerol Ester of Rosin, Red 40.",
                flagged = listOf(
                    FlagInfo("Red 40", 25, "high", "Petroleum-derived synthetic azo dye linked to hyperactivity in children.")
                ),
                nutritionScore = 0,
                nutriGrade = "E",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "NOOMA Organic Electrolyte Sports Drink",
                    "NOOMA",
                    92,
                    productImageUrl("NOOMA Organic Electrolyte Sports Drink"),
                    "Filtered Water, Organic Coconut Water, Organic Natural Flavors, Himalayan Pink Salt, Organic Stevia Leaf Extract."
                )
            ),
            sampleItem(
                title = "Prime Hydration Drink Ice Pop, 16.9 fl oz",
                brand = "Prime",
                category = "Waters, Seltzers & Hydration",
                score = 42,
                rating = "Poor",
                color = "orange",
                imageUrl = productImageUrl("Prime Hydration Drink Ice Pop 16.9 oz"),
                description = "Coconut-water sports hydration beverage with electrolytes and BCAAs, sweetened with sucralose and acesulfame potassium.",
                keywords = "prime hydration drink ice pop blue raspberry tropical punch logan paul",
                ingredients = "Filtered Water, Coconut Water from Concentrate, Citric Acid, Dipotassium Phosphate, Trimagnesium Citrate, Natural Flavor, Sucralose, L-Isoleucine, L-Leucine, L-Valine, D-Alpha Tocopheryl Acetate, Acesulfame Potassium, Beta Carotene for Color, Pyridoxine Hydrochloride, Cyanocobalamin.",
                flagged = listOf(
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener."),
                    FlagInfo("Acesulfame Potassium (Ace-K)", 15, "moderate", "Synthetic high-intensity sweetener.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "NOOMA Organic Electrolyte Sports Drink",
                    "NOOMA",
                    92,
                    productImageUrl("NOOMA Organic Electrolyte Sports Drink"),
                    "Filtered Water, Organic Coconut Water, Organic Natural Flavors, Himalayan Pink Salt, Organic Stevia Leaf Extract."
                )
            ),
            // ==================== JUICES, SMOOTHIES & TEA ====================
            sampleItem(
                title = "Simply Orange Pulp Free 100% Pure Squeezed Orange Juice, 52 fl oz",
                brand = "Simply",
                category = "Juices, Smoothies & Tea",
                score = 72,
                rating = "Good",
                color = "yellow",
                imageUrl = productImageUrl("Simply Orange Pulp Free 100% Orange Juice"),
                description = "100% pure squeezed non-GMO pasteurized orange juice, never from concentrate, with zero added sugars or preservatives.",
                keywords = "simply orange juice pulp free tropicana 100% orange juice oj",
                ingredients = "100% Pure Squeezed Pasteurized Orange Juice.",
                flagged = emptyList(),
                nutritionScore = 42,
                nutriGrade = "B",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            sampleItem(
                title = "Harmless Harvest Organic Coconut Water, 16 fl oz",
                brand = "Harmless Harvest",
                category = "Juices, Smoothies & Tea",
                score = 88,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Harmless Harvest Organic Coconut Water"),
                description = "Single-ingredient USDA Organic young Nam Hom coconut water from Thailand, micro-filtered rather than thermally pasteurized.",
                keywords = "harmless harvest organic coconut water pink coconut water electrolytes",
                ingredients = "100% Organic Coconut Water.",
                flagged = emptyList(),
                nutritionScore = 48,
                nutriGrade = "B",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "SunnyD Tangy Original Citrus Punch, 64 fl oz",
                brand = "SunnyD",
                category = "Juices, Smoothies & Tea",
                score = 6,
                rating = "Bad",
                color = "red",
                imageUrl = productImageUrl("SunnyD Tangy Original Citrus Punch"),
                description = "Sweetened citrus punch with only 5% juice, high fructose corn syrup, canola oil, sucralose, Ace-K, Yellow 5, and Yellow 6.",
                keywords = "sunnyd sunny delight citrus punch orange drink",
                ingredients = "Water, High Fructose Corn Syrup and 2% or Less of: Concentrated Juices (Orange, Tangerine, Apple, Lime, Grapefruit, Pear), Citric Acid, Ascorbic Acid, Thiamin Hydrochloride, Natural Flavors, Modified Cornstarch, Canola Oil, Sodium Citrate, Cellulose Gum, Sucralose, Acesulfame Potassium, Neotame, Sodium Hexametaphosphate, Potassium Sorbate, Yellow 5, Yellow 6.",
                flagged = listOf(
                    FlagInfo("Yellow 5", 25, "high", "Synthetic azo dye."),
                    FlagInfo("Yellow 6", 25, "high", "Synthetic azo dye."),
                    FlagInfo("Canola Oil", 15, "moderate", "Refined industrial seed oil."),
                    FlagInfo("High-Fructose Corn Syrup", 15, "moderate", "Industrial liquid sweetener."),
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener.")
                ),
                nutritionScore = 0,
                nutriGrade = "E",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "Uncle Matt's Organic 100% Orange Juice",
                    "Uncle Matt's Organic",
                    88,
                    productImageUrl("Uncle Matt's Organic Orange Juice"),
                    "100% Organic Pasteurized Orange Juice."
                )
            ),
            sampleItem(
                title = "Starbucks Frappuccino Mocha Chilled Coffee Drink, 13.7 fl oz Bottle",
                brand = "Starbucks",
                category = "Juices, Smoothies & Tea",
                score = 30,
                rating = "Poor",
                color = "orange",
                imageUrl = productImageUrl("Starbucks Frappuccino Mocha Coffee Drink Bottle"),
                description = "Sweetened bottled iced coffee drink made with reduced-fat milk, coffee, 46g total sugars, and pectin.",
                keywords = "starbucks frappuccino mocha vanilla caramel iced coffee drink bottle",
                ingredients = "Brewed Starbucks Coffee (Water, Coffee), Reduced-Fat Milk, Sugar, Cocoa, Natural Flavors, Pectin, Ascorbic Acid.",
                flagged = emptyList(),
                nutritionScore = 0,
                nutriGrade = "E",
                additiveScore = 30,
                organicScore = 0,
                swap = swapObj(
                    "Stok Organic Unsweetened Black Cold Brew Coffee",
                    "Stok",
                    94,
                    productImageUrl("Stok Unsweetened Black Cold Brew Coffee"),
                    "Coffee (Filtered Water, Organic Arabica Coffee)."
                )
            ),
            // ==================== ADDITIONAL MILK & PLANT MILKS ====================
            sampleItem(
                title = "Fairlife Ultra-Filtered Whole Milk, Lactose-Free, 52 fl oz",
                brand = "Fairlife",
                category = "Milk & Dairy",
                score = 90,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Fairlife Ultra Filtered Whole Milk 52 oz"),
                description = "Ultra-filtered lactose-free whole milk with 50% more protein (13g) and 50% less sugar (6g) than regular milk.",
                keywords = "fairlife milk whole milk 2% milk ultra filtered lactose free high protein",
                ingredients = "Ultra-Filtered Milk, Lactase Enzyme, Vitamin A Palmitate, Vitamin D3.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            sampleItem(
                title = "MALK Organic Unsweetened Almond Milk, 28 fl oz",
                brand = "MALK Organics",
                category = "Milk & Dairy",
                score = 100,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("MALK Organic Unsweetened Almond Milk"),
                description = "3-ingredient USDA Organic almond milk with zero seed oils, zero gums, zero carrageenan, and zero synthetic fillers.",
                keywords = "malk organic almond milk oat milk clean plant milk",
                ingredients = "Filtered Water, Organic Almonds, Himalayan Pink Salt.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "Oatly Original Oat Milk, 64 fl oz",
                brand = "Oatly",
                category = "Milk & Dairy",
                score = 63,
                rating = "Good",
                color = "yellow",
                imageUrl = productImageUrl("Oatly Original Oat Milk 64 oz"),
                description = "Creamy Swedish oat milk fortified with vitamins; contains refined rapeseed (canola) oil and dipotassium phosphate.",
                keywords = "oatly oat milk original barista edition plant milk",
                ingredients = "Oat Base (Water, Oats), Low Erucic Acid Rapeseed Oil, Contains 2% or Less of: Dipotassium Phosphate, Calcium Carbonate, Tricalcium Phosphate, Sea Salt, Dicalcium Phosphate, Riboflavin, Vitamin A Acetate, Vitamin D2, Vitamin B12.",
                flagged = listOf(
                    FlagInfo("Canola / Rapeseed Oil", 15, "moderate", "Refined industrial seed oil used for mouthfeel.")
                ),
                nutritionScore = 48,
                nutriGrade = "B",
                additiveScore = 15,
                organicScore = 0,
                swap = swapObj(
                    "MALK Organic Unsweetened Oat Milk (3 Ingredients)",
                    "MALK Organics",
                    98,
                    productImageUrl("MALK Organic Oat Milk"),
                    "Filtered Water, Organic Gluten-Free Oats, Himalayan Pink Salt."
                )
            ),
            sampleItem(
                title = "Nesquik Chocolate Lowfat Milk Ready-to-Drink, 14 fl oz",
                brand = "Nesquik",
                category = "Milk & Dairy",
                score = 18,
                rating = "Bad",
                color = "red",
                imageUrl = productImageUrl("Nesquik Chocolate Lowfat Milk 14 oz"),
                description = "Sweetened ready-to-drink chocolate lowfat milk containing 27g sugars and carrageenan thickener.",
                keywords = "nesquik chocolate milk strawberry milk truemoo darigold",
                ingredients = "Lowfat Milk with Vitamin A Palmitate and Vitamin D3 Added, Sugar, Less than 2% of Cocoa Processed with Alkali, Nonfat Milk, Salt, Natural and Artificial Flavor, Carrageenan, Cellulose Gel, Cellulose Gum.",
                flagged = listOf(
                    FlagInfo("Carrageenan", 25, "high", "Seaweed thickener linked to intestinal inflammation.")
                ),
                nutritionScore = 12,
                nutriGrade = "D",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "Horizon Organic Lowfat Chocolate Milk",
                    "Horizon Organic",
                    76,
                    productImageUrl("Horizon Organic Lowfat Chocolate Milk"),
                    "Organic Grade A Lowfat Milk, Organic Cane Sugar, Organic Fair Trade Cocoa, Gellan Gum, Vitamin A Palmitate, Vitamin D3."
                )
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
        swap: JSONObject?,
        description: String = "",
        keywords: String = ""
    ): JSONObject = JSONObject().apply {
        put("ok", true)
        put("category", category)
        put("product", JSONObject().apply {
            put("title", title)
            put("brand", brand)
            put("category", category)
            put("imageUrl", imageUrl)
            put("ingredients", ingredients)
            if (description.isNotBlank()) put("description", description)
            if (keywords.isNotBlank()) put("keywords", keywords)
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
