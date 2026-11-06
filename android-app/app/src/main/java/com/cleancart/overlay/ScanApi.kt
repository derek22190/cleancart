package com.cleancart.overlay

import android.content.Context
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/** Minimal HTTP client for POST /api/scan (no third-party dependencies). */
object ScanApi {
    private const val PREFS = "cleancart"
    private const val KEY_API = "api_base"

    fun baseUrl(ctx: Context): String =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_API, null)
            ?.takeIf { it.isNotBlank() } ?: BuildConfig.API_BASE

    fun saveBaseUrl(ctx: Context, url: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_API, url.trim().trimEnd('/')).apply()
    }

    /** Blocking call — run off the main thread. Returns the raw JSON response body. */
    fun scan(ctx: Context, productTitle: String, rawIngredients: String?, store: String): String {
        val body = JSONObject().apply {
            put("productTitle", productTitle)
            if (!rawIngredients.isNullOrBlank()) put("rawIngredients", rawIngredients)
            put("store", store)
            put("format", "json")
        }.toString()

        val conn = (URL("${baseUrl(ctx).trimEnd('/')}/api/scan").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 8000
            readTimeout = 15000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
        }
        try {
            conn.outputStream.use { it.write(body.toByteArray()) }
            val stream = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
            return stream?.bufferedReader()?.use(BufferedReader::readText)
                ?: """{"ok":false,"error":"Empty response (${conn.responseCode})"}"""
        } finally {
            conn.disconnect()
        }
    }

    fun storeForPackage(pkg: String): String = when (pkg) {
        "com.walmart.android" -> "walmart"
        "com.instacart.client" -> "instacart"
        "com.target.ui" -> "target"
        "com.kroger.mobile" -> "kroger"
        "de.apptiv.business.android.aldi_us" -> "aldi"
        "com.dd.doordash" -> "doordash"
        "com.ubercab.eats" -> "ubereats"
        "com.amazon.mShop.android.shopping" -> "amazon"
        "com.samsclub.app" -> "sams"
        "com.bjs.mobile" -> "bjs"
        "com.costco.app.android" -> "costco"
        "com.shipt.groceries" -> "shipt"
        else -> "walmart"
    }

    /** Offline sample used by "Launch Test Overlay Pill" if the API isn't reachable. */
    const val SAMPLE_JSON = """
    {"ok":true,"product":{"title":"Berry Swirl Strawberry Lowfat Yogurt"},
     "result":{"score":35,"rating":"Poor","color":"red","flagged":[
       {"id":"red40","name":"Red 40","risk":"high","penalty":35,"explanation":"A petroleum-derived dye linked to hyperactivity in sensitive children and requiring a warning label in the EU."},
       {"id":"hfcs","name":"High Fructose Corn Syrup","risk":"moderate","penalty":20,"explanation":"A highly refined industrial sweetener tied to fatty-liver and metabolic issues when consumed regularly."},
       {"id":"ksorbate","name":"Potassium Sorbate","risk":"low","penalty":10,"explanation":"A common mold inhibitor that is generally low risk but signals a highly shelf-stabilized product."}]},
     "swap":{"title":"Stonyfield Organic Whole Milk Plain Yogurt","score":100,
       "webUrl":"https://www.walmart.com/search?q=Stonyfield%20Organic%20Whole%20Milk%20Plain%20Yogurt&irgwc=1&clickid=YOUR_IMPACT_ID",
       "deepLink":"https://www.walmart.com/search?q=Stonyfield%20Organic%20Whole%20Milk%20Plain%20Yogurt&irgwc=1&clickid=YOUR_IMPACT_ID",
       "androidPackage":"com.walmart.android"}}
    """
}
