cmake_minimum_required(VERSION 3.14)
project(voice-drawing-backend VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# MSVC: UTF-8 编码 + 消除 getenv 警告
if(MSVC)
    add_compile_options(/utf-8 /D_CRT_SECURE_NO_WARNINGS)
endif()

# ============================================================
# 本地 header-only 库（手动下载到 include/ 目录）
# ============================================================
add_library(httplib INTERFACE)
target_include_directories(httplib INTERFACE ${CMAKE_SOURCE_DIR}/include)

add_library(nlohmann_json INTERFACE)
target_include_directories(nlohmann_json INTERFACE ${CMAKE_SOURCE_DIR}/include)

# ============================================================
# 可执行文件
# ============================================================
add_executable(server server.cpp)

target_link_libraries(server PRIVATE httplib nlohmann_json)

# Windows 下链接 ws2_32（httplib 需要）
if(WIN32)
    target_link_libraries(server PRIVATE ws2_32)
endif()
