NEXUS//TRAFFIC

AI Traffic Signal Optimization Simulator

Overview

NEXUS//TRAFFIC is a dual-engine traffic simulation platform that compares traditional fixed-time traffic signals with an AI-driven adaptive signal control system in a controlled A/B environment.

The simulator models a 12×12 urban grid with configurable vehicle density and traffic light distribution. Two identical simulations run in parallel:

Static Engine (fixed green cycles)

AI Engine (demand-weighted signal redistribution)

This allows accurate measurement of how intelligent signal control impacts congestion and wait times.

Problem

Most real-world traffic systems operate on fixed timing schedules that do not adapt to real-time vehicle density. This causes:

Increased congestion

Longer waiting times

Fuel wastage

Higher emissions

An adaptive signal system can improve efficiency without new infrastructure.

Solution

The AI engine analyzes queue density at intersections and dynamically redistributes a fixed green-time budget between directions. Total cycle time remains constant, ensuring optimization without increasing capacity.

Features

Configurable vehicle count

Adjustable number of traffic lights

Real-time simulation (Canvas rendering)

Live AI vs Static comparison

Heatmap congestion visualization

Timed analysis mode (1–60 minutes)

Detailed performance report

Metrics Tracked

Average waiting time per vehicle

Maximum waiting time

Percentage of vehicles waiting

Fleet-level total delay

AI improvement percentage

Tech Stack

React (Functional Components & Hooks)

Canvas API

Custom simulation engine

Queue-density based optimization

Exponential smoothing algorithm

Installation

npm install
npm start

Purpose

This project demonstrates how AI-driven signal timing alone can reduce congestion and improve urban mobility without additional hardware infrastructure.
