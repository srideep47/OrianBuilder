cmake_minimum_required(VERSION 3.24)
project(OrianTensorRtRunner LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(OrianTensorRtRunner
  src/main.cpp
)

if (WIN32)
  target_compile_definitions(OrianTensorRtRunner PRIVATE
    NOMINMAX
    WIN32_LEAN_AND_MEAN
  )
endif()

if (DEFINED TENSORRT_ROOT AND NOT "${TENSORRT_ROOT}" STREQUAL "")
  find_path(TENSORRT_INCLUDE_DIR NvInfer.h PATHS "${TENSORRT_ROOT}/include" NO_DEFAULT_PATH)
  find_library(TENSORRT_LIB nvinfer PATHS "${TENSORRT_ROOT}/lib" NO_DEFAULT_PATH)
  if (TENSORRT_INCLUDE_DIR AND TENSORRT_LIB)
    target_compile_definitions(OrianTensorRtRunner PRIVATE ORIAN_HAVE_TENSORRT=1)
    target_include_directories(OrianTensorRtRunner PRIVATE ${TENSORRT_INCLUDE_DIR})
    target_link_libraries(OrianTensorRtRunner PRIVATE ${TENSORRT_LIB})
    message(STATUS "TensorRT SDK enabled: ${TENSORRT_ROOT}")
  else()
    message(WARNING "TENSORRT_ROOT was set, but NvInfer.h/nvinfer.lib were not found. Building protocol-only runner.")
  endif()
else()
  message(STATUS "TENSORRT_ROOT not set. Building protocol-only runner.")
endif()

set_target_properties(OrianTensorRtRunner PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_SOURCE_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_CURRENT_SOURCE_DIR}/bin"
)
