package com.cleancart.overlay

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams

/**
 * Google Play Store distribution billing coordinator (`play` product flavor).
 * Uses Google Play Billing Library exclusively for all subscription purchases and management.
 */
object PlayBillingCoordinator {
    const val EXTRA_OPEN_PLAY_PAYWALL = "com.cleancart.overlay.OPEN_PLAY_PAYWALL"
    private const val ANNUAL_PRODUCT_ID = "heybroc_pro_annual"
    private const val MONTHLY_PRODUCT_ID = "heybroc_pro_monthly"
    private const val PLAY_SUBSCRIPTIONS_URL = "https://play.google.com/store/account/subscriptions"
    private const val TERMS_URL = "https://www.heybroc.com/terms"
    private const val PRIVACY_URL = "https://www.heybroc.com/privacy"

    private val mainHandler = Handler(Looper.getMainLooper())

    fun openUpgradeFromContext(context: Context) {
        val intent = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(EXTRA_OPEN_PLAY_PAYWALL, true)
        }
        runCatching { context.startActivity(intent) }
    }

    fun openManageSubscription(activity: Activity) {
        val pkg = Uri.encode(activity.packageName)
        val url = "$PLAY_SUBSCRIPTIONS_URL?package=$pkg"
        runCatching {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        }.onFailure {
            Toast.makeText(activity, "Open Google Play → Payments & subscriptions to manage your plan.", Toast.LENGTH_LONG).show()
        }
    }

    fun openUpgradeFlow(activity: Activity, onProActivated: (() -> Unit)? = null) {
        if (activity.isFinishing || activity.isDestroyed) return
        val appCtx = activity.applicationContext
        val density = activity.resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density + 0.5f).toInt()

        var dialogRef: AlertDialog? = null
        var billingClient: BillingClient? = null
        var annualDetails: ProductDetails? = null
        var monthlyDetails: ProductDetails? = null

        val statusView = TextView(activity).apply {
            text = "Loading Google Play plans…"
            textSize = 12.5f
            setTextColor(0xFF475569.toInt())
            setPadding(0, dp(4), 0, dp(8))
        }
        val priceHeadlineView = TextView(activity).apply {
            text = "$49.99/year"
            textSize = 26f
            setTypeface(null, Typeface.BOLD)
            setTextColor(0xFF0F172A.toInt())
        }
        val priceSubView = TextView(activity).apply {
            text = "or $9.99/month • Includes 7-day free trial for eligible new subscribers"
            textSize = 12.5f
            setTextColor(0xFF475569.toInt())
            setPadding(0, dp(2), 0, 0)
        }
        val annualBtn = TextView(activity).apply {
            text = "$49.99/year — Annual Plan\n7-day free trial, then $49.99/year"
            textSize = 14.5f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(14), dp(16), dp(14))
            background = GradientDrawable().apply {
                setColor(0xFF16A34A.toInt())
                cornerRadius = dp(14).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(8) }
        }
        val monthlyBtn = TextView(activity).apply {
            text = "$9.99/month — Monthly Plan"
            textSize = 14f
            setTypeface(null, Typeface.BOLD)
            setTextColor(0xFF0F172A.toInt())
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(12), dp(16), dp(12))
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                setStroke(dp(1), 0xFFCBD5E1.toInt())
                cornerRadius = dp(14).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(10) }
        }
        val disclosureView = TextView(activity).apply {
            text = "Auto-renewable subscription billed through Google Play: 7-day free trial for eligible new subscribers, then $49.99/year (or $9.99/month). Subscription renews automatically unless canceled in Google Play → Payments & subscriptions before renewal."
            textSize = 11f
            setTextColor(0xFF64748B.toInt())
            setPadding(0, dp(8), 0, dp(4))
        }

        fun formatRecurringPrice(details: ProductDetails?, fallback: String): String {
            val phases = details?.subscriptionOfferDetails
                ?.firstOrNull()
                ?.pricingPhases
                ?.pricingPhaseList
                .orEmpty()
            val paidPhase = phases.lastOrNull { it.priceAmountMicros > 0L } ?: phases.lastOrNull()
            return paidPhase?.formattedPrice?.takeIf { it.isNotBlank() } ?: fallback
        }

        fun handleVerifiedPurchases(client: BillingClient, purchases: List<Purchase>, isRestore: Boolean) {
            val activePurchases = purchases.filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }
            if (activePurchases.isEmpty()) {
                if (isRestore) {
                    mainHandler.post {
                        statusView.text = "No active Google Play subscription found on this Google account."
                    }
                }
                return
            }
            for (purchase in activePurchases) {
                val productId = purchase.products.firstOrNull().orEmpty()
                val orderId = purchase.orderId.orEmpty()
                val token = purchase.purchaseToken
                if (!purchase.isAcknowledged) {
                    val ackParams = AcknowledgePurchaseParams.newBuilder()
                        .setPurchaseToken(token)
                        .build()
                    client.acknowledgePurchase(ackParams) { /* handled alongside server verification */ }
                }
                Thread {
                    val verified = ScanApi.verifyGooglePlayPurchase(
                        ctx = appCtx,
                        purchaseToken = token,
                        productId = productId,
                        orderId = orderId
                    )
                    mainHandler.post {
                        if (verified?.optBoolean("active", false) == true) {
                            Toast.makeText(appCtx, "HeyBroc Family Pro activated!", Toast.LENGTH_LONG).show()
                            dialogRef?.dismiss()
                            onProActivated?.invoke()
                        } else {
                            val err = verified?.optString("error").orEmpty()
                                .ifBlank { "Purchase recorded on Google Play. Syncing your Pro access…" }
                            statusView.text = err
                        }
                    }
                }.start()
            }
        }

        val purchasesUpdatedListener = PurchasesUpdatedListener { billingResult, purchases ->
            when (billingResult.responseCode) {
                BillingClient.BillingResponseCode.OK -> {
                    if (!purchases.isNullOrEmpty()) {
                        billingClient?.let { handleVerifiedPurchases(it, purchases, isRestore = false) }
                    }
                }
                BillingClient.BillingResponseCode.USER_CANCELED -> {
                    mainHandler.post { statusView.text = "No charge made — continue scanning free anytime." }
                }
                else -> {
                    mainHandler.post {
                        statusView.text = billingResult.debugMessage.ifBlank { "Google Play Billing could not complete right now." }
                    }
                }
            }
        }

        val client = BillingClient.newBuilder(appCtx)
            .setListener(purchasesUpdatedListener)
            .enablePendingPurchases(
                PendingPurchasesParams.newBuilder()
                    .enableOneTimeProducts()
                    .build()
            )
            .build()
        billingClient = client

        fun launchPurchase(details: ProductDetails?) {
            if (details == null) {
                Toast.makeText(activity, "Google Play plans are still loading. Please try again in a moment.", Toast.LENGTH_SHORT).show()
                return
            }
            val offerToken = details.subscriptionOfferDetails?.firstOrNull()?.offerToken
            if (offerToken.isNullOrBlank()) {
                statusView.text = "Selected Google Play subscription offer is currently unavailable."
                return
            }
            ScanApi.trackEvent(activity, "checkout_started")
            val productParams = BillingFlowParams.ProductDetailsParams.newBuilder()
                .setProductDetails(details)
                .setOfferToken(offerToken)
                .build()
            val flowParams = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(listOf(productParams))
                .build()
            client.launchBillingFlow(activity, flowParams)
        }

        annualBtn.setOnClickListener { launchPurchase(annualDetails) }
        monthlyBtn.setOnClickListener { launchPurchase(monthlyDetails) }

        val card = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(18), dp(20), dp(18))
            setBackgroundColor(0xFFF8FAFC.toInt())
            addView(TextView(activity).apply {
                text = "🥦 HEYBROC FAMILY PRO"
                textSize = 11.5f
                setTypeface(null, Typeface.BOLD)
                setTextColor(0xFF0F7A4A.toInt())
            })
            addView(TextView(activity).apply {
                text = "HeyBroc Family Pro"
                textSize = 21f
                setTypeface(null, Typeface.BOLD)
                setTextColor(0xFF0F172A.toInt())
                setPadding(0, dp(4), 0, dp(10))
            })
            addView(LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), dp(12), dp(14), dp(12))
                background = GradientDrawable().apply {
                    setColor(Color.WHITE)
                    setStroke(dp(2), 0xFF16A34A.toInt())
                    cornerRadius = dp(14).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(10) }
                addView(priceHeadlineView)
                addView(priceSubView)
            })
            addView(TextView(activity).apply {
                text = "• Unlimited 1-Tap Clean Swaps across all 12 grocery stores\n• Live 0–100 score badges inside HeyBroc In-App Live Shop\n• Custom Family Watchlist & Allergy Alerts synced across devices"
                textSize = 12.5f
                setTextColor(0xFF14532D.toInt())
                setPadding(dp(12), dp(10), dp(12), dp(10))
                background = GradientDrawable().apply {
                    setColor(0xFFECFDF5.toInt())
                    setStroke(dp(1), 0xFF86EFAC.toInt())
                    cornerRadius = dp(12).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(8) }
            })
            addView(statusView)
            addView(annualBtn)
            addView(monthlyBtn)

            addView(LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                addView(TextView(activity).apply {
                    text = "Restore Purchases"
                    textSize = 12.5f
                    setTypeface(null, Typeface.BOLD)
                    setTextColor(0xFF0F7A4A.toInt())
                    setPadding(dp(10), dp(8), dp(10), dp(8))
                    setOnClickListener {
                        statusView.text = "Checking Google Play purchases…"
                        val qParams = QueryPurchasesParams.newBuilder()
                            .setProductType(BillingClient.ProductType.SUBS)
                            .build()
                        client.queryPurchasesAsync(qParams) { res, list ->
                            if (res.responseCode == BillingClient.BillingResponseCode.OK) {
                                handleVerifiedPurchases(client, list, isRestore = true)
                            } else {
                                mainHandler.post { statusView.text = "Unable to query Google Play right now." }
                            }
                        }
                    }
                })
                addView(TextView(activity).apply {
                    text = "Manage Subscription"
                    textSize = 12.5f
                    setTextColor(0xFF475569.toInt())
                    setPadding(dp(10), dp(8), dp(10), dp(8))
                    setOnClickListener { openManageSubscription(activity) }
                })
            })

            addView(LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                addView(TextView(activity).apply {
                    text = "Terms of Use"
                    textSize = 12f
                    setTypeface(null, Typeface.BOLD)
                    setTextColor(0xFF0F7A4A.toInt())
                    setPadding(dp(10), dp(4), dp(10), dp(4))
                    setOnClickListener {
                        runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(TERMS_URL))) }
                    }
                })
                addView(TextView(activity).apply {
                    text = "Privacy Policy"
                    textSize = 12f
                    setTypeface(null, Typeface.BOLD)
                    setTextColor(0xFF0F7A4A.toInt())
                    setPadding(dp(10), dp(4), dp(10), dp(4))
                    setOnClickListener {
                        runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PRIVACY_URL))) }
                    }
                })
            })
            addView(disclosureView)
        }

        val scroll = ScrollView(activity).apply { addView(card) }
        val dlg = AlertDialog.Builder(activity)
            .setView(scroll)
            .setNegativeButton("Continue with Free Plan", null)
            .create()
        dlg.setOnDismissListener {
            runCatching { client.endConnection() }
        }
        dialogRef = dlg
        ScanApi.trackEvent(activity, "paywall_viewed")
        dlg.show()

        client.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(billingResult: BillingResult) {
                if (billingResult.responseCode != BillingClient.BillingResponseCode.OK) {
                    mainHandler.post {
                        statusView.text = "Google Play Billing unavailable on this device. Sign in to sync an existing Pro account or continue free."
                    }
                    return
                }
                val productList = listOf(
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(ANNUAL_PRODUCT_ID)
                        .setProductType(BillingClient.ProductType.SUBS)
                        .build(),
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(MONTHLY_PRODUCT_ID)
                        .setProductType(BillingClient.ProductType.SUBS)
                        .build()
                )
                val params = QueryProductDetailsParams.newBuilder()
                    .setProductList(productList)
                    .build()
                client.queryProductDetailsAsync(params) { res, detailsList ->
                    mainHandler.post {
                        if (res.responseCode == BillingClient.BillingResponseCode.OK) {
                            annualDetails = detailsList.firstOrNull { it.productId == ANNUAL_PRODUCT_ID }
                            monthlyDetails = detailsList.firstOrNull { it.productId == MONTHLY_PRODUCT_ID }
                            val annualPrice = formatRecurringPrice(annualDetails, "$49.99")
                            val monthlyPrice = formatRecurringPrice(monthlyDetails, "$9.99")
                            priceHeadlineView.text = "$annualPrice/year"
                            priceSubView.text = "or $monthlyPrice/month • Includes 7-day free trial for eligible new subscribers"
                            annualBtn.text = "$annualPrice/year — Annual Plan\n7-day free trial, then $annualPrice/year"
                            monthlyBtn.text = "$monthlyPrice/month — Monthly Plan"
                            disclosureView.text = "Auto-renewable subscription billed through Google Play: 7-day free trial for eligible new subscribers, then $annualPrice/year (or $monthlyPrice/month). Subscription renews automatically unless canceled in Google Play → Payments & subscriptions before renewal."
                            statusView.text = if (annualDetails != null || monthlyDetails != null) {
                                "Choose a Google Play plan below, or continue free anytime."
                            } else {
                                "Google Play plans are currently unavailable in this region."
                            }
                        } else {
                            statusView.text = "Unable to load Google Play plans right now."
                        }
                    }
                }
            }

            override fun onBillingServiceDisconnected() {
                mainHandler.post {
                    statusView.text = "Google Play connection interrupted — tap again to retry."
                }
            }
        })
    }
}
