plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val apiBase: String = (project.findProperty("cleancartApiBase") as String?) ?: "https://heybroc.com"

android {
    namespace = "com.cleancart.overlay"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.cleancart.overlay"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "1.1.0"
        buildConfigField("String", "API_BASE", "\"$apiBase\"")
    }

    buildFeatures { buildConfig = true }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

// No third-party dependencies: plain Android framework views + HttpURLConnection + org.json.
