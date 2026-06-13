
## Requirements for the passing the exam

This file describes all functionality that the LLM layer must have in order to be sufficent for the exam. It is important to follow all directive described in this document (e.g. "Your system should decide when it is convenient to complete a special mission and when it is better to ignore it" it's a mandatory design requirement).

All code related example are contained in the folder c:\Users\Davide Cabitza\GitHub\AMS---Autonous-Software-Agents-for-Deliveroo.js\lab:
• lab8 contains material related to the general LLM layer.
• missionAgents contains material related to the second challenge. The LLM architecture of our project must be able to adress all challenges as described in this document.

We have two agents: one BDI (also called worker or A) and one LLM (also called coordinator or B).

• Standard mission:
    • Collect and deliver parcels (as in the first challenge)
    • Both agents (BDI and LLM) can perform this mission at the same time

• Special missions
    • DeliverooJS will also send you special missions written in natural language.
    • These missions must be: read by the LLM agent, interpreted by the LLM agent, executed by your system. They require an LLM.

Examples of special missions are described in the following pharagraphs. They are very similar to the ones you will encounter during the challenge.

• Special missions usually give many more points than standard parcel collection and delivery.
• However, some special missions may not always be worth completing.
• Your system should decide when it is convenient to complete a special mission and when it is better to ignore it.


## Special missions - Examples

Special missions are divided into three levels of complexity:

1. Atomic special missions:

• Relatively simple, atomic missions
• Can be solved with small modifications to the code shown in the LLM-based agents tutorials

2. Intermediate special missions:

• Require additional internal tools to be completed efficiently
• Are non-atomic but persistent: they remain active for the entire duration of the match
• Require the agent to adapt its game strategy in order to satisfy the prompt request.

3. Missions requiring coordination or communication:

    Require a communication mechanism between:
        • the BDI agent and the LLM agent
        • The LLM agent and the game chat


## Special missions – Level 1

Atomic missions require standard tools to be completed. E.g., move, calculate, pick-up, put-down, …

Examples:

• Move to coordinate (4,7)  and you get +10pts

• Move to x=4*2 y=(1+3)*3 to get -10pts

• Drop a package in the leftmost tile to get 5pt

• Drop a package in the leftmost tile to get -10pt

• What is the capital of Italy?

• Calculate 5*5

Send the answer to the agent who sent the prompt


## Special missions – Level 2

Level 2 missions require the agent to adapt its game strategy in order to satisfy the prompt request.
Consider using additional tools to modify the standard pick-up and delivery behaviour

Examples:

• Deliver stacks of exactly 3 parcels at a time to double the reward

• Deliver stacks of exactly 5 parcels at a time to get 0.3 of the standard reward

• Every time you deliver in (x1,y1) or (x2,y2) you get 5x pts than in a regular delivery tile

• Every time you deliver in (x1,y1) you get 0 pts

• If you deliver parcels with a score higher than 10, you get no reward.

• Do not go through tile (x,y) otherwise you lose 50pts.


## Special missions – Level 3

Level 3 missions require multi-agent coordination and communication tools.

Examples:

• Move both agents to the neighborhood of position (x,y) within a maximum distance of 3, and have

them wait for each other. You will receive 500pts.

• If a parcel is initially picked up by one agent and later delivered by the other agent, you will receive a

200 points bonus.

• All agents must move to an odd-numbered row and wait for our message before moving again, as in

a “red light, green light” game. 700 points bonus.